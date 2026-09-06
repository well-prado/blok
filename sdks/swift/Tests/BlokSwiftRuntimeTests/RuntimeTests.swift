import Foundation
import XCTest
@testable import BlokSwiftRuntime

final class RuntimeTests: XCTestCase {
    func testTypedGreetUsesTypedJSONContract() async throws {
        let node = TypedGreetNode()
        let context = ExecutionContext(
            trigger: TriggerContext(
                body: Data(), headers: [:], params: [:], query: [:], cookies: [:],
                method: "POST", url: "/", baseURL: "", kind: "test"
            ),
            state: RuntimeState(previousOutput: Data(), vars: Data(), environment: [:]),
            workflow: WorkflowContext(runID: "test", name: "test", path: "", version: "1"),
            logger: StructuredLogger()
        )

        let output = try await node.run(
            context: context,
            input: TypedGreetInput(name: "Ada", repeatCount: 2)
        )

        XCTAssertEqual(output.greeting, "Hello, AdaHello, Ada")
        XCTAssertEqual(output.length, output.greeting.utf8.count)
    }

    func testCapabilityPolicyFailsClosedWhenConfigured() throws {
        let policy = CapabilityPolicy(environment: [
            "BLOK_REQUIRE_CAPABILITY_MANIFEST": "true",
            "BLOK_ALLOWED_CAPABILITIES": "network.read",
        ])

        XCTAssertThrowsError(try policy.check(nil, node: "untrusted")) { error in
            let blokError = error as? BlokError
            XCTAssertEqual(blokError?.code, "CAPABILITY_MANIFEST_REQUIRED")
        }

        let denied = CapabilityManifest(
            classification: "agent-compatible",
            capabilities: ["filesystem.write"],
            determinism: "deterministic",
            idempotency: "idempotent",
            maturity: "stable"
        )
        XCTAssertThrowsError(try policy.check(denied, node: "untrusted")) { error in
            let blokError = error as? BlokError
            XCTAssertEqual(blokError?.code, "CAPABILITY_NOT_APPROVED")
        }
    }

    func testClaimCheckResolvesRunScopedBlobID() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("blok-claim-\(UUID().uuidString)", isDirectory: true)
        let runDirectory = root.appendingPathComponent("spec-b-e2e", isDirectory: true)
        let blobURL = runDirectory.appendingPathComponent("payload.json")
        let payload = Data(#"{"name":"Ada","repeat":2}"#.utf8)
        try FileManager.default.createDirectory(at: runDirectory, withIntermediateDirectories: true)
        try payload.write(to: blobURL)
        defer { try? FileManager.default.removeItem(at: root) }

        let reference = Data(#"{"$blokBlob":{"id":"spec-b-e2e/payload.json","bytes":25,"codec":"json"}}"#.utf8)
        let resolved = try ClaimCheckResolver.resolve(reference, environment: ["BLOK_BLOB_DIR": root.path])

        XCTAssertEqual(resolved, payload)
    }
}
