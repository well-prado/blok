import Foundation

public struct TriggerContext: Sendable {
    public let body: Data
    public let headers: [String: String]
    public let params: [String: String]
    public let query: [String: String]
    public let cookies: [String: String]
    public let method: String
    public let url: String
    public let baseURL: String
    public let kind: String
}

public struct RuntimeState: Sendable {
    public let previousOutput: Data
    public let vars: Data
    public let environment: [String: String]
}

public struct WorkflowContext: Sendable {
    public let runID: String
    public let name: String
    public let path: String
    public let version: String
}

public struct LogLineData: Sendable {
    public let level: String
    public let message: String
    public let attributes: [String: String]
    public let timestamp: Date
}

public actor StructuredLogger {
    private var entries: [LogLineData] = []

    public init() {}

    public func log(_ level: String, _ message: String, attributes: [String: String] = [:]) {
        entries.append(LogLineData(level: level, message: message, attributes: attributes, timestamp: Date()))
    }

    public func debug(_ message: String, attributes: [String: String] = [:]) {
        log("debug", message, attributes: attributes)
    }

    public func info(_ message: String, attributes: [String: String] = [:]) {
        log("info", message, attributes: attributes)
    }

    public func warn(_ message: String, attributes: [String: String] = [:]) {
        log("warn", message, attributes: attributes)
    }

    public func error(_ message: String, attributes: [String: String] = [:]) {
        log("error", message, attributes: attributes)
    }

    public func snapshot() -> [LogLineData] { entries }
}

public struct ExecutionContext: Sendable {
    public let trigger: TriggerContext
    public let state: RuntimeState
    public let workflow: WorkflowContext
    public let logger: StructuredLogger

    public init(trigger: TriggerContext, state: RuntimeState, workflow: WorkflowContext, logger: StructuredLogger) {
        self.trigger = trigger
        self.state = state
        self.workflow = workflow
        self.logger = logger
    }

    public var isCancelled: Bool { Task.isCancelled }

    public func checkCancellation() throws {
        if Task.isCancelled { throw BlokError.cancelled() }
    }
}
