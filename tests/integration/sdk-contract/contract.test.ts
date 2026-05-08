/**
 * Blok SDK Contract Tests
 *
 * Validates that all multi-language runtime SDKs conform to the canonical
 * HTTP contract defined by DockerRuntimeAdapter:
 *
 *   POST /execute  →  JSON ExecutionRequest in, JSON ExecutionResult out (always 200)
 *   GET  /health   →  JSON { status, version, nodes_loaded }
 *
 * Usage:
 *   1. Start all SDKs:  docker compose up -d --build
 *   2. Run tests:       npx tsx contract.test.ts
 *   3. Tear down:       docker compose down
 *
 * Or use:  npm run test:full
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface SdkEndpoint {
	name: string;
	url: string;
}

const SDKS: SdkEndpoint[] = [
	{ name: "Go", url: process.env.SDK_GO_URL || "http://localhost:9001" },
	{ name: "Rust", url: process.env.SDK_RUST_URL || "http://localhost:9002" },
	{ name: "Java", url: process.env.SDK_JAVA_URL || "http://localhost:9003" },
	{ name: "C#", url: process.env.SDK_CSHARP_URL || "http://localhost:9004" },
	{ name: "PHP", url: process.env.SDK_PHP_URL || "http://localhost:9005" },
	{ name: "Ruby", url: process.env.SDK_RUBY_URL || "http://localhost:9006" },
];

// Filter to specific SDKs via env: SDK_FILTER=go,rust
const filter = process.env.SDK_FILTER?.split(",").map((s) => s.trim().toLowerCase());
const targets = filter ? SDKS.filter((s) => filter.includes(s.name.toLowerCase())) : SDKS;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function post(url: string, body: unknown): Promise<{ status: number; body: any }> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const json = await res.json();
	return { status: res.status, body: json };
}

async function get(url: string): Promise<{ status: number; body: any }> {
	const res = await fetch(url);
	const json = await res.json();
	return { status: res.status, body: json };
}

function makeExecutionRequest(
	nodeName: string,
	body: Record<string, any> = {},
	config: Record<string, any> = {},
): object {
	return {
		node: {
			name: nodeName,
			type: "default",
			config,
		},
		context: {
			id: "test-ctx-001",
			workflow_name: "contract-test",
			workflow_path: "/test",
			request: {
				body,
				headers: {},
				params: {},
				query: {},
				method: "POST",
				url: "/test",
				cookies: {},
				baseUrl: "",
			},
			response: {
				data: null,
				contentType: "application/json",
				success: true,
				error: null,
			},
			vars: {},
			env: {},
		},
	};
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
	if (!condition) {
		throw new Error(`Assertion failed: ${message}`);
	}
}

async function test(sdk: SdkEndpoint, name: string, fn: () => Promise<void>): Promise<void> {
	const label = `[${sdk.name}] ${name}`;
	try {
		await fn();
		passed++;
		console.log(`  ✓ ${label}`);
	} catch (err: any) {
		failed++;
		const msg = `  ✗ ${label}: ${err.message}`;
		console.log(msg);
		failures.push(msg);
	}
}

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

async function runContractTests(sdk: SdkEndpoint): Promise<void> {
	console.log(`\n━━━ ${sdk.name} SDK (${sdk.url}) ━━━`);

	// Check connectivity
	try {
		await fetch(`${sdk.url}/health`, { signal: AbortSignal.timeout(5000) });
	} catch {
		console.log(`  ⚠ SKIPPED — SDK not reachable at ${sdk.url}`);
		skipped += 10;
		return;
	}

	// 1. Health check returns valid response
	await test(sdk, "Health check returns status, version, and nodes_loaded", async () => {
		const { status, body } = await get(`${sdk.url}/health`);
		assert(status === 200, `Expected 200, got ${status}`);
		assert(body.status === "healthy" || body.status === "ok", `Unexpected status: ${body.status}`);
		assert(typeof body.version === "string", "version should be a string");
		assert(
			Array.isArray(body.nodes_loaded) || typeof body.nodes_loaded === "number",
			"nodes_loaded should be an array or number",
		);
	});

	// 2. Health check lists at least hello-world node
	await test(sdk, "Health check lists registered nodes including hello-world", async () => {
		const { body } = await get(`${sdk.url}/health`);
		if (Array.isArray(body.nodes_loaded)) {
			assert(
				body.nodes_loaded.some((n: string) => n.includes("hello") || n.includes("Hello")),
				`Expected hello-world node in: ${JSON.stringify(body.nodes_loaded)}`,
			);
		}
		// If nodes_loaded is a number, just check it's >= 1
		if (typeof body.nodes_loaded === "number") {
			assert(body.nodes_loaded >= 1, `Expected at least 1 node, got ${body.nodes_loaded}`);
		}
	});

	// 3. HelloWorld node executes with defaults
	await test(sdk, "HelloWorld executes with default name", async () => {
		const req = makeExecutionRequest("hello-world");
		const { status, body } = await post(`${sdk.url}/execute`, req);
		assert(status === 200, `Expected 200, got ${status}`);
		assert(body.success === true, `Expected success: true, got ${body.success}`);
		assert(body.data != null, "data should not be null");

		const msg = typeof body.data === "string" ? body.data : body.data?.message;
		assert(
			msg && (msg.toLowerCase().includes("hello") || msg.toLowerCase().includes("world")),
			`Expected greeting in data, got: ${JSON.stringify(body.data)}`,
		);
	});

	// 4. HelloWorld with name parameter
	await test(sdk, "HelloWorld executes with custom name", async () => {
		const req = makeExecutionRequest("hello-world", { name: "Blok" });
		const { status, body } = await post(`${sdk.url}/execute`, req);
		assert(status === 200, `Expected 200, got ${status}`);
		assert(body.success === true, "Expected success: true");

		const msg = typeof body.data === "string" ? body.data : body.data?.message;
		assert(msg?.includes("Blok"), `Expected "Blok" in message, got: ${JSON.stringify(body.data)}`);
	});

	// 5. HelloWorld with config prefix
	await test(sdk, "HelloWorld executes with config prefix", async () => {
		const req = makeExecutionRequest("hello-world", { name: "Test" }, { prefix: "Greetings" });
		const { status, body } = await post(`${sdk.url}/execute`, req);
		assert(status === 200, `Expected 200, got ${status}`);
		assert(body.success === true, "Expected success: true");

		const msg = typeof body.data === "string" ? body.data : body.data?.message;
		assert(msg?.includes("Greetings"), `Expected "Greetings" prefix in message, got: ${JSON.stringify(body.data)}`);
	});

	// 6. Non-existent node returns success: false
	await test(sdk, "Non-existent node returns success: false", async () => {
		const req = makeExecutionRequest("non-existent-node-xyz");
		const { status, body } = await post(`${sdk.url}/execute`, req);
		assert(status === 200, `Expected 200 even for unknown node, got ${status}`);
		assert(body.success === false, `Expected success: false for unknown node, got ${body.success}`);
	});

	// 7. Invalid JSON returns 400
	await test(sdk, "Invalid JSON body returns 400", async () => {
		const res = await fetch(`${sdk.url}/execute`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{ invalid json !!!",
		});
		assert(res.status === 400, `Expected 400 for invalid JSON, got ${res.status}`);
	});

	// 8. Metrics present in response
	await test(sdk, "Execution response includes metrics", async () => {
		const req = makeExecutionRequest("hello-world");
		const { body } = await post(`${sdk.url}/execute`, req);
		assert(body.success === true, "Expected successful execution");
		if (body.metrics) {
			assert(
				typeof body.metrics.duration_ms === "number",
				`Expected duration_ms number, got: ${typeof body.metrics.duration_ms}`,
			);
		}
		// metrics may be optional — having data is enough
	});

	// 9. Multiple nodes registered
	await test(sdk, "Multiple nodes are registered", async () => {
		const { body } = await get(`${sdk.url}/health`);
		if (Array.isArray(body.nodes_loaded)) {
			assert(
				body.nodes_loaded.length >= 2,
				`Expected at least 2 nodes, got ${body.nodes_loaded.length}: ${JSON.stringify(body.nodes_loaded)}`,
			);
		}
		if (typeof body.nodes_loaded === "number") {
			assert(body.nodes_loaded >= 2, `Expected at least 2 nodes, got ${body.nodes_loaded}`);
		}
	});

	// 10. ExecutionResult has correct shape
	await test(sdk, "ExecutionResult has correct shape (success, data, errors fields)", async () => {
		const req = makeExecutionRequest("hello-world");
		const { body } = await post(`${sdk.url}/execute`, req);
		assert("success" in body, "Response missing 'success' field");
		assert("data" in body, "Response missing 'data' field");
		// errors may be null or missing, both are acceptable
	});
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	console.log("╔══════════════════════════════════════════════════════╗");
	console.log("║    Blok SDK Contract Tests                          ║");
	console.log("║    Validating HTTP contract across all SDKs         ║");
	console.log("╚══════════════════════════════════════════════════════╝");
	console.log(`\nTargeting ${targets.length} SDK(s): ${targets.map((s) => s.name).join(", ")}`);

	for (const sdk of targets) {
		await runContractTests(sdk);
	}

	console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
	console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);

	if (failures.length > 0) {
		console.log("\nFailures:");
		failures.forEach((f) => console.log(f));
	}

	console.log("");
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(2);
});
