import Foundation

public struct CapabilityResourceBounds: Codable, Sendable, Equatable {
    public var maxDurationMs: Int?
    public var maxMemoryBytes: Int?
    public var maxInputBytes: Int?
    public var maxOutputBytes: Int?
    public var maxConcurrency: Int?

    public init(
        maxDurationMs: Int? = nil,
        maxMemoryBytes: Int? = nil,
        maxInputBytes: Int? = nil,
        maxOutputBytes: Int? = nil,
        maxConcurrency: Int? = nil
    ) {
        self.maxDurationMs = maxDurationMs
        self.maxMemoryBytes = maxMemoryBytes
        self.maxInputBytes = maxInputBytes
        self.maxOutputBytes = maxOutputBytes
        self.maxConcurrency = maxConcurrency
    }
}

public struct CapabilityManifest: Codable, Sendable, Equatable {
    public var version: String
    public var classification: String
    public var effects: [String]
    public var capabilities: [String]
    public var secrets: [String]
    public var determinism: String
    public var idempotency: String
    public var maturity: String
    public var resources: CapabilityResourceBounds?
    public var runtimes: [String]?
    public var triggers: [String]?

    public init(
        version: String = "1",
        classification: String,
        effects: [String] = [],
        capabilities: [String] = [],
        secrets: [String] = [],
        determinism: String,
        idempotency: String,
        maturity: String,
        resources: CapabilityResourceBounds? = nil,
        runtimes: [String]? = nil,
        triggers: [String]? = nil
    ) {
        self.version = version
        self.classification = classification
        self.effects = effects
        self.capabilities = capabilities
        self.secrets = secrets
        self.determinism = determinism
        self.idempotency = idempotency
        self.maturity = maturity
        self.resources = resources
        self.runtimes = runtimes
        self.triggers = triggers
    }

    public func jsonData() throws -> Data {
        try JSONEncoder().encode(self)
    }
}

public struct CapabilityPolicy: Sendable {
    public let allowed: Set<String>?
    public let requireManifest: Bool

    public init(environment: [String: String] = ProcessInfo.processInfo.environment) {
        let raw = environment["BLOK_ALLOWED_CAPABILITIES"]?
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        self.allowed = raw.map(Set.init)
        self.requireManifest = ["1", "true", "yes", "on"].contains(
            environment["BLOK_REQUIRE_CAPABILITY_MANIFEST"]?.lowercased()
        )
    }

    public func check(_ manifest: CapabilityManifest?, node: String) throws {
        if requireManifest && manifest == nil {
            throw BlokError.permission(
                code: "CAPABILITY_MANIFEST_REQUIRED",
                message: "Node '\(node)' has no capability manifest"
            )
        }
        guard let allowed else { return }
        let requested = Set(manifest?.capabilities ?? [])
        let denied = requested.subtracting(allowed).sorted()
        if !denied.isEmpty {
            throw BlokError.permission(
                code: "CAPABILITY_NOT_APPROVED",
                message: "Node '\(node)' requests capabilities that are not approved",
                details: ["capabilities": denied]
            )
        }
    }
}
