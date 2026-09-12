import Foundation

private func schema(_ value: String) -> Data { Data(value.utf8) }

public struct TypedGreetInput: Codable, Sendable {
    public let name: String
    public let repeatCount: Int

    public init(name: String, repeatCount: Int = 1) {
        self.name = name
        self.repeatCount = repeatCount
    }

    enum CodingKeys: String, CodingKey { case name; case repeatCount = "repeat" }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        repeatCount = try container.decodeIfPresent(Int.self, forKey: .repeatCount) ?? 1
    }
}

public struct TypedGreetOutput: Codable, Sendable {
    public let greeting: String
    public let length: Int
}

public struct TypedGreetNode: TypedNode {
    public let name = "typed-greet"
    public let description = "Typed greeting (SPEC-B contract demo)"
    public let inputSchema = schema("""
    {"type":"object","required":["name"],"properties":{"name":{"type":"string"},"repeat":{"type":"integer","default":1}}}
    """)
    public let outputSchema = schema("""
    {"type":"object","required":["greeting","length"],"properties":{"greeting":{"type":"string"},"length":{"type":"integer"}}}
    """)
    public let capabilityManifest: CapabilityManifest? = CapabilityManifest(
        classification: "agent-compatible",
        determinism: "deterministic",
        idempotency: "idempotent",
        maturity: "stable",
        resources: CapabilityResourceBounds(
            maxDurationMs: 5000,
            maxInputBytes: 4194304,
            maxOutputBytes: 4194304,
            maxConcurrency: 64
        )
    )

    public func run(context: ExecutionContext, input: TypedGreetInput) async throws -> TypedGreetOutput {
        try context.checkCancellation()
        let repeatCount = max(1, input.repeatCount)
        let greeting = String(repeating: "Hello, \(input.name)", count: repeatCount)
        return TypedGreetOutput(greeting: greeting, length: greeting.utf8.count)
    }
}

public struct ChainTestNode: NodeHandler {
    public let name = "chain-test"
    public let description = "Cross-runtime chain conformance node"
    public let inputSchema: Data? = schema("""
    {"type":"object","properties":{"chain":{"type":"array"},"origin":{"type":"string"}}}
    """)
    public let outputSchema: Data? = schema("""
    {"type":"object","required":["chain","origin"],"properties":{"chain":{"type":"array"},"origin":{"type":"string"}}}
    """)
    public let capabilityManifest: CapabilityManifest? = nil

    public func execute(context: ExecutionContext, input: Data) async throws -> Data {
        try context.checkCancellation()
        var object = (try JSONSerialization.jsonObject(with: input) as? [String: Any]) ?? [:]
        var chain = object["chain"] as? [[String: Any]] ?? []
        let origin = object["origin"] as? String ?? "unknown"
        chain.append([
            "language": "swift",
            "order": chain.count + 1,
            "timestamp": ISO8601DateFormatter().string(from: Date()),
        ])
        object["chain"] = chain
        object["origin"] = origin
        return try JSONSerialization.data(withJSONObject: ["chain": chain, "origin": origin])
    }
}

public struct StandardDataNode: NodeHandler {
    public let name = "standard-data"
    public let description = "Standard JSON data conformance node"
    public let inputSchema: Data? = schema("{\"type\":\"object\"}")
    public let outputSchema: Data? = schema("{\"type\":\"object\",\"required\":[\"language\",\"data\"]}")
    public let capabilityManifest: CapabilityManifest? = nil

    public func execute(context: ExecutionContext, input: Data) async throws -> Data {
        try context.checkCancellation()
        let value = try JSONSerialization.jsonObject(with: input)
        return try JSONSerialization.data(withJSONObject: ["language": "swift", "data": value])
    }
}

/// Canonical cross-runtime greeting, same contract as every other SDK:
/// `inputs.prefix` + the trigger body's `name` → `{message, timestamp, language}`.
public struct HelloWorldNode: NodeHandler {
    public let name = "hello-world"
    public let description = "Returns a greeting from the Swift runtime."
    public let inputSchema: Data? = schema("""
    {"type":"object","properties":{"prefix":{"type":"string","default":"Hello from the Swift runtime"}}}
    """)
    public let outputSchema: Data? = schema("""
    {"type":"object","required":["message","timestamp","language"],"properties":{"message":{"type":"string"},"timestamp":{"type":"string"},"language":{"type":"string"}}}
    """)
    public let capabilityManifest: CapabilityManifest? = nil

    public func execute(context: ExecutionContext, input: Data) async throws -> Data {
        try context.checkCancellation()
        let object = (try? JSONSerialization.jsonObject(with: input) as? [String: Any]) ?? [:]
        let prefix = (object["prefix"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Hello from the Swift runtime"
        let body = (try? JSONSerialization.jsonObject(with: context.trigger.body) as? [String: Any]) ?? [:]
        let who = (body["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "World"
        return try JSONSerialization.data(withJSONObject: [
            "message": "\(prefix), \(who)!",
            "timestamp": ISO8601DateFormatter().string(from: Date()),
            "language": "swift",
        ])
    }
}

public func registerBuiltins(_ registry: NodeRegistry) {
    registry.register("hello-world", HelloWorldNode())
    registry.register(TypedGreetNode())
    registry.register("chain-test", ChainTestNode())
    registry.register("standard-data", StandardDataNode())
}
