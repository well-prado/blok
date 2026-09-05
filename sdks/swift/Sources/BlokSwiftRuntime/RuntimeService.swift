import Foundation
import GRPCCore
import SwiftProtobuf

public final class NodeRuntimeService: Blok_Runtime_V1_NodeRuntime.SimpleServiceProtocol, @unchecked Sendable {
    private let registry: NodeRegistry
    private let sdkVersion: String
    private let environment: [String: String]

    public init(
        registry: NodeRegistry,
        sdkVersion: String = "1.0.0",
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.registry = registry
        self.sdkVersion = sdkVersion
        self.environment = environment
    }

    public func execute(
        request: Blok_Runtime_V1_ExecuteRequest,
        context: ServerContext
    ) async throws -> Blok_Runtime_V1_ExecuteResponse {
        await executeMessage(request, context: context)
    }

    public func executeStream(
        request: Blok_Runtime_V1_ExecuteRequest,
        response: RPCWriter<Blok_Runtime_V1_ExecuteEvent>,
        context: ServerContext
    ) async throws {
        let started = Blok_Runtime_V1_NodeStarted.with { timestamp in
            timestamp.at = nowTimestamp()
        }
        let finalResponse = await executeMessage(request, context: context)
        let final = Blok_Runtime_V1_ExecuteEvent.with { event in
            event.final = finalResponse
        }
        let start = Blok_Runtime_V1_ExecuteEvent.with { event in
            event.started = started
        }
        try await response.write(start)
        try await response.write(final)
    }

    public func health(
        request: Blok_Runtime_V1_HealthRequest,
        context: ServerContext
    ) async throws -> Blok_Runtime_V1_HealthResponse {
        let response = Blok_Runtime_V1_HealthResponse.with { health in
            health.status = .serving
            health.sdkVersion = sdkVersion
            health.registeredNodes = registry.names()
        }
        return response
    }

    public func listNodes(
        request: Blok_Runtime_V1_ListNodesRequest,
        context: ServerContext
    ) async throws -> Blok_Runtime_V1_ListNodesResponse {
        let descriptors = registry.names().compactMap { name -> Blok_Runtime_V1_NodeDescriptor? in
            guard let handler = registry.handler(named: name) else { return nil }
            var descriptor = Blok_Runtime_V1_NodeDescriptor()
            descriptor.name = handler.name
            descriptor.description_p = handler.description
            descriptor.inputSchemaJson = handler.inputSchema ?? Data()
            descriptor.outputSchemaJson = handler.outputSchema ?? Data()
            if let manifest = handler.capabilityManifest, let data = try? manifest.jsonData() {
                descriptor.capabilityManifestJson = data
            }
            return descriptor
        }
        let response = Blok_Runtime_V1_ListNodesResponse.with { list in
            list.nodes = descriptors
            list.sdkName = "blok-swift"
            list.sdkVersion = sdkVersion
            list.protoVersion = "1.0.0"
            list.capabilities = ClaimCheckResolver.capabilities(environment: environment)
        }
        return response
    }

    private func executeMessage(
        _ message: Blok_Runtime_V1_ExecuteRequest,
        context: ServerContext
    ) async -> Blok_Runtime_V1_ExecuteResponse {
        let nodeName = message.node.name
        let started = ContinuousClock.now
        let logger = StructuredLogger()
        do {
            guard !message.node.name.isEmpty else {
                throw BlokError(code: "NODE_REF_REQUIRED", category: .protocolError, message: "ExecuteRequest.node is required", httpStatus: 400)
            }
            let input = try ClaimCheckResolver.resolve(message.inputs, environment: environment)
            let trigger = message.trigger
            let state = message.state
            let workflow = message.workflow
            let executionContext = ExecutionContext(
                trigger: TriggerContext(
                    body: trigger.body,
                    headers: trigger.headers,
                    params: trigger.params,
                    query: trigger.query,
                    cookies: trigger.cookies,
                    method: trigger.method,
                    url: trigger.url,
                    baseURL: trigger.baseUrl,
                    kind: trigger.triggerKind
                ),
                state: RuntimeState(previousOutput: state.previousOutput, vars: state.vars, environment: state.env),
                workflow: WorkflowContext(runID: workflow.runId, name: workflow.name, path: workflow.path, version: workflow.version),
                logger: logger
            )
            if context.cancellation.isCancelled {
                throw BlokError.cancelled()
            }
            let data = try await executeWithDeadline(
                nodeName: node.name,
                input: input,
                context: executionContext,
                deadlineMs: message.options.deadlineMs,
                cancellation: context.cancellation
            )
            var response = Blok_Runtime_V1_ExecuteResponse()
            response.success = true
            response.data = data
            response.contentType = "application/json"
            response.logs = await logger.snapshot().map(protoLog)
            response.metrics = metrics(since: started, requestBytes: message.inputs.count, responseBytes: data.count)
            return response
        } catch let error as BlokError {
            return await failure(error, node: nodeName, logger: logger, started: started)
        } catch is CancellationError {
            return await failure(.cancelled(), node: nodeName, logger: logger, started: started)
        } catch {
            return await failure(
                BlokError(code: "NODE_EXECUTION_FAILED", category: .internalError, message: error.localizedDescription),
                node: nodeName,
                logger: logger,
                started: started
            )
        }
    }

    private func executeWithDeadline(
        nodeName: String,
        input: Data,
        context: ExecutionContext,
        deadlineMs: Int64,
        cancellation: ServerContext.RPCCancellationHandle
    ) async throws -> Data {
        return try await withThrowingTaskGroup(of: Data.self) { group in
            group.addTask { try await self.registry.execute(name: nodeName, context: context, input: input) }
            group.addTask {
                try await cancellation.cancelled
                throw BlokError.cancelled()
            }
            if deadlineMs > 0 {
                group.addTask {
                    try await Task.sleep(nanoseconds: UInt64(deadlineMs) * 1_000_000)
                    throw BlokError.timeout()
                }
            }
            guard let result = try await group.next() else { throw BlokError.timeout() }
            group.cancelAll()
            return result
        }
    }

    private func failure(
        _ error: BlokError,
        node: String,
        logger: StructuredLogger,
        started: ContinuousClock.Instant
    ) async -> Blok_Runtime_V1_ExecuteResponse {
        var response = Blok_Runtime_V1_ExecuteResponse()
        response.success = false
        response.contentType = "application/json"
        response.error = protoError(error, node: node)
        response.logs = await logger.snapshot().map(protoLog)
        response.metrics = metrics(since: started, requestBytes: 0, responseBytes: 0)
        return response
    }

    private func protoLog(_ line: LogLineData) -> Blok_Runtime_V1_LogLine {
        Blok_Runtime_V1_LogLine.with { log in
            log.timestamp = timestamp(line.timestamp)
            log.level = line.level
            log.message = line.message
            log.attributes = line.attributes
        }
    }

    private func metrics(
        since: ContinuousClock.Instant,
        requestBytes: Int,
        responseBytes: Int
    ) -> Blok_Runtime_V1_Metrics {
        let duration = since.duration(to: .now)
        let milliseconds = Double(duration.components.seconds) * 1000
            + Double(duration.components.attoseconds) / 1_000_000_000_000_000
        return Blok_Runtime_V1_Metrics.with { value in
            value.durationMs = milliseconds
            value.requestBytes = Int64(requestBytes)
            value.responseBytes = Int64(responseBytes)
        }
    }

    private func protoError(_ error: BlokError, node: String) -> Blok_Runtime_V1_NodeError {
        Blok_Runtime_V1_NodeError.with { value in
            value.code = error.code
            value.category = errorCategory(error.category)
            value.severity = errorSeverity(error.severity)
            value.node = error.node ?? node
            value.sdk = "blok-swift"
            value.sdkVersion = sdkVersion
            value.runtimeKind = "runtime.swift"
            value.at = timestamp(error.at)
            value.message = error.message
            value.description_p = error.description
            value.remediation = error.remediation
            value.httpStatus = error.httpStatus
            value.retryable = error.retryable
            value.retryAfterMs = error.retryAfterMs
            if let details = error.details { value.detailsJson = detailsJSON(details) }
        }
    }

    private func detailsJSON(_ details: [String: AnySendable]) -> Data {
        var json: [String: Any] = [:]
        for (key, value) in details {
            switch value {
            case .string(let value): json[key] = value
            case .integer(let value): json[key] = value
            case .boolean(let value): json[key] = value
            case .strings(let value): json[key] = value
            }
        }
        return (try? JSONSerialization.data(withJSONObject: json)) ?? Data()
    }
}

private func timestamp(_ date: Date) -> Google_Protobuf_Timestamp {
    Google_Protobuf_Timestamp.with { value in
        value.seconds = Int64(date.timeIntervalSince1970)
        value.nanos = Int32((date.timeIntervalSince1970 - floor(date.timeIntervalSince1970)) * 1_000_000_000)
    }
}

private func nowTimestamp() -> Google_Protobuf_Timestamp { timestamp(Date()) }

private func errorCategory(_ category: BlokErrorCategory) -> Blok_Runtime_V1_ErrorCategory {
    switch category {
    case .validation: return .validation
    case .configuration: return .configuration
    case .dependency: return .dependency
    case .timeout: return .timeout
    case .permission: return .permission
    case .rateLimit: return .rateLimit
    case .notFound: return .notFound
    case .conflict: return .conflict
    case .cancelled: return .cancelled
    case .internalError: return .internal
    case .protocolError: return .protocol
    case .data: return .data
    }
}

private func errorSeverity(_ severity: BlokErrorSeverity) -> Blok_Runtime_V1_ErrorSeverity {
    switch severity {
    case .info: return .info
    case .warn: return .warn
    case .error: return .error
    case .fatal: return .fatal
    }
}
