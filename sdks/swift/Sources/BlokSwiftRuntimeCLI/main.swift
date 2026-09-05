import Dispatch
import Foundation
import GRPCCore
import GRPCNIOTransportHTTP2
import BlokSwiftRuntime

#if os(Linux)
import Glibc
#else
import Darwin
#endif

private final class ShutdownSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Never>?
    private var finished = false
    private var sources: [DispatchSourceSignal] = []

    init() {
        for value in [SIGINT, SIGTERM] {
            signal(value, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: value, queue: .main)
            source.setEventHandler { [weak self] in self?.finish() }
            source.resume()
            sources.append(source)
        }
    }

    deinit { sources.forEach { $0.cancel() } }

    func wait() async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if finished {
                lock.unlock()
                continuation.resume()
            } else {
                self.continuation = continuation
                lock.unlock()
            }
        }
    }

    private func finish() {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume()
    }
}

@main
struct BlokSwiftRuntimeCLI {
    static func main() async throws {
        let environment = ProcessInfo.processInfo.environment
        let registry = NodeRegistry()
        registerBuiltins(registry)
        GeneratedUserNodeRegistry.registerAll(registry)

        let port = max(1, min(65535, Int(environment["GRPC_PORT"] ?? "10008") ?? 10008))
        let healthPort = max(1, min(65535, Int(environment["HEALTH_PORT"] ?? "9008") ?? 9008))
        let host = environment["HOST"] ?? "0.0.0.0"
        let maxMessageBytes = max(1, min(
            256 * 1024 * 1024,
            Int(environment["BLOK_GRPC_MAX_MESSAGE_BYTES"] ?? "16777216") ?? 16777216
        ))
        var config = HTTP2ServerTransport.Posix.Config.defaults
        config.rpc.maxRequestPayloadSize = maxMessageBytes
        config.connection.keepalive = .init(
            time: .milliseconds(Int64(environment["BLOK_GRPC_KEEPALIVE_TIME_MS"] ?? "10000") ?? 10000),
            timeout: .milliseconds(Int64(environment["BLOK_GRPC_KEEPALIVE_TIMEOUT_MS"] ?? "5000") ?? 5000),
            clientBehavior: .init(minPingIntervalWithoutCalls: .seconds(60), allowWithoutCalls: true)
        )

        let transport = HTTP2ServerTransport.Posix(
            address: host == "0.0.0.0" ? .ipv4(host: host, port: port) : .ipv4(host: host, port: port),
            transportSecurity: .plaintext,
            config: config
        )
        let service = NodeRuntimeService(registry: registry)
        let server = GRPCServer(transport: transport, services: [service])
        let health = try await HealthHTTPServer.start(host: host, port: healthPort)
        let shutdown = ShutdownSignal()

        print("Blok Swift runtime listening on \(host):\(port) (gRPC), /health on :\(healthPort) with \(registry.names().count) nodes")
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await server.serve() }
            group.addTask {
                await shutdown.wait()
                server.beginGracefulShutdown()
                await health.stop()
            }
            try await group.next()
            group.cancelAll()
        }
    }
}
