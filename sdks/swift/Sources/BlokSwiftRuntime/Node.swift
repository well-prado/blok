import Foundation

public protocol NodeHandler: Sendable {
    var name: String { get }
    var description: String { get }
    var inputSchema: Data? { get }
    var outputSchema: Data? { get }
    var capabilityManifest: CapabilityManifest? { get }

    func execute(context: ExecutionContext, input: Data) async throws -> Data
}

public protocol TypedNode: Sendable {
    associatedtype Input: Decodable & Sendable
    associatedtype Output: Encodable & Sendable

    var name: String { get }
    var description: String { get }
    var inputSchema: Data { get }
    var outputSchema: Data { get }
    var capabilityManifest: CapabilityManifest? { get }

    func run(context: ExecutionContext, input: Input) async throws -> Output
}

public extension TypedNode {
    var description: String { "" }
    var capabilityManifest: CapabilityManifest? { nil }

    func asHandler() -> any NodeHandler { TypedNodeHandler(self) }
}

private struct TypedNodeHandler<T: TypedNode>: NodeHandler {
    let node: T

    var name: String { node.name }
    var description: String { node.description }
    var inputSchema: Data? { node.inputSchema }
    var outputSchema: Data? { node.outputSchema }
    var capabilityManifest: CapabilityManifest? { node.capabilityManifest }

    func execute(context: ExecutionContext, input: Data) async throws -> Data {
        let value: T.Input
        do {
            value = try JSONDecoder().decode(T.Input.self, from: input)
        } catch {
            throw BlokError.validation(
                message: "Input validation failed for node '\(node.name)': \(error.localizedDescription)"
            )
        }
        try context.checkCancellation()
        let output = try await node.run(context: context, input: value)
        do {
            return try JSONEncoder().encode(output)
        } catch {
            throw BlokError(
                code: "NODE_OUTPUT_SERIALIZATION",
                category: .internalError,
                message: "Output serialization failed for node '\(node.name)': \(error.localizedDescription)"
            )
        }
    }
}

public final class NodeRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var handlers: [String: any NodeHandler] = [:]
    private let policy: CapabilityPolicy

    public init(policy: CapabilityPolicy = CapabilityPolicy()) {
        self.policy = policy
    }

    public func register(_ name: String, _ handler: any NodeHandler) {
        lock.lock()
        handlers[name] = handler
        lock.unlock()
    }

    public func register<T: TypedNode>(_ node: T) {
        register(node.name, node.asHandler())
    }

    public func names() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return handlers.keys.sorted()
    }

    public func handler(named name: String) -> (any NodeHandler)? {
        lock.lock()
        defer { lock.unlock() }
        return handlers[name]
    }

    public func execute(name: String, context: ExecutionContext, input: Data) async throws -> Data {
        guard let handler = handler(named: name) else {
            throw BlokError(
                code: "NODE_NOT_FOUND",
                category: .notFound,
                message: "Node '\(name)' is not registered",
                httpStatus: 404
            )
        }
        try policy.check(handler.capabilityManifest, node: name)
        return try await handler.execute(context: context, input: input)
    }
}
