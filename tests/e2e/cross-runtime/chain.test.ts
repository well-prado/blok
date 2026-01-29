/**
 * Cross-Runtime Chain E2E Test
 *
 * Validates that a single workflow can chain nodes across all 8 language
 * runtimes (NodeJS, Go, Rust, Java, C#, PHP, Ruby, Python3), passing
 * ctx.response.data between them.
 *
 * Prerequisites:
 *   1. SDK containers running:  docker compose up -d --build
 *   2. Python3 runtime running: cd runtimes/python3 && python server.py
 *   3. Blok HTTP server running on port 4000
 *
 * Usage:
 *   npx tsx chain.test.ts
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BLOK_URL = process.env.BLOK_URL || "http://localhost:4000";
const WORKFLOW_PATH = "cross-runtime-chain";

const EXPECTED_LANGUAGES = [
	"nodejs",
	"go",
	"rust",
	"java",
	"csharp",
	"php",
	"ruby",
	"python3",
];

interface SdkEndpoint {
	name: string;
	url: string;
}

const SDK_CONTAINERS: SdkEndpoint[] = [
	{ name: "Go", url: process.env.SDK_GO_URL || "http://localhost:9001" },
	{ name: "Rust", url: process.env.SDK_RUST_URL || "http://localhost:9002" },
	{ name: "Java", url: process.env.SDK_JAVA_URL || "http://localhost:9003" },
	{ name: "C#", url: process.env.SDK_CSHARP_URL || "http://localhost:9004" },
	{ name: "PHP", url: process.env.SDK_PHP_URL || "http://localhost:9005" },
	{ name: "Ruby", url: process.env.SDK_RUBY_URL || "http://localhost:9006" },
];

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
	if (!condition) {
		throw new Error(`Assertion failed: ${message}`);
	}
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
		passed++;
		console.log(`  \u2713 ${name}`);
	} catch (err: unknown) {
		failed++;
		const msg = `  \u2717 ${name}: ${(err as Error).message}`;
		console.log(msg);
		failures.push(msg);
	}
}

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

async function checkSdkHealth(): Promise<void> {
	console.log("\n--- SDK Container Health Checks ---");

	for (const sdk of SDK_CONTAINERS) {
		await test(`${sdk.name} SDK is healthy at ${sdk.url}`, async () => {
			const res = await fetch(`${sdk.url}/health`, {
				signal: AbortSignal.timeout(5000),
			});
			assert(res.ok, `HTTP ${res.status}`);
			const body = await res.json() as Record<string, unknown>;
			assert(
				body.status === "healthy" || body.status === "ok",
				`status=${body.status}`,
			);
			// Check that chain-test node is registered
			if (Array.isArray(body.nodes_loaded)) {
				assert(
					(body.nodes_loaded as string[]).includes("chain-test"),
					`chain-test not in nodes: ${JSON.stringify(body.nodes_loaded)}`,
				);
			}
		});
	}
}

async function checkBlokHealth(): Promise<void> {
	console.log("\n--- Blok Server Health Check ---");

	await test(`Blok server is reachable at ${BLOK_URL}`, async () => {
		const res = await fetch(`${BLOK_URL}/health`, {
			signal: AbortSignal.timeout(5000),
		});
		assert(res.ok || res.status === 404 || res.status === 500, `HTTP ${res.status} — server unreachable`);
	});
}

// ---------------------------------------------------------------------------
// Chain test
// ---------------------------------------------------------------------------

async function runChainTest(): Promise<void> {
	console.log("\n--- Cross-Runtime Chain Test ---");

	await test("POST to chain workflow returns 200", async () => {
		const res = await fetch(`${BLOK_URL}/${WORKFLOW_PATH}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
			signal: AbortSignal.timeout(30000),
		});
		assert(res.ok, `Expected 200, got ${res.status}`);
	});

	// Run the full chain and validate
	let chainResponse: Record<string, unknown> | null = null;

	await test("Chain response contains data", async () => {
		const res = await fetch(`${BLOK_URL}/${WORKFLOW_PATH}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
			signal: AbortSignal.timeout(30000),
		});
		const body = await res.json();
		chainResponse = body as Record<string, unknown>;
		assert(chainResponse !== null, "Response body is null");
	});

	await test("Response has chain array", async () => {
		assert(chainResponse !== null, "No response to validate");
		// The response could be nested in data or at top level
		const data = (chainResponse as Record<string, unknown>).data || chainResponse;
		const chain = (data as Record<string, unknown>).chain;
		assert(Array.isArray(chain), `chain is not an array: ${JSON.stringify(data)}`);
	});

	await test("Chain has exactly 8 entries (one per language)", async () => {
		assert(chainResponse !== null, "No response to validate");
		const data = (chainResponse as Record<string, unknown>).data || chainResponse;
		const chain = (data as Record<string, unknown>).chain as unknown[];
		assert(
			chain.length === 8,
			`Expected 8 entries, got ${chain.length}: ${JSON.stringify(chain.map((e: unknown) => (e as Record<string, unknown>).language))}`,
		);
	});

	await test("All 8 languages are present in correct order", async () => {
		assert(chainResponse !== null, "No response to validate");
		const data = (chainResponse as Record<string, unknown>).data || chainResponse;
		const chain = (data as Record<string, unknown>).chain as Array<Record<string, unknown>>;

		const languages = chain.map((entry) => entry.language);

		for (let i = 0; i < EXPECTED_LANGUAGES.length; i++) {
			assert(
				languages[i] === EXPECTED_LANGUAGES[i],
				`Entry ${i}: expected "${EXPECTED_LANGUAGES[i]}", got "${languages[i]}"`,
			);
		}
	});

	await test("Each entry has language, order, and timestamp", async () => {
		assert(chainResponse !== null, "No response to validate");
		const data = (chainResponse as Record<string, unknown>).data || chainResponse;
		const chain = (data as Record<string, unknown>).chain as Array<Record<string, unknown>>;

		for (const entry of chain) {
			assert(typeof entry.language === "string", `Missing language: ${JSON.stringify(entry)}`);
			assert(typeof entry.order === "number", `Missing order: ${JSON.stringify(entry)}`);
			assert(typeof entry.timestamp === "string", `Missing timestamp: ${JSON.stringify(entry)}`);
		}
	});

	await test("Order numbers are sequential (1 through 8)", async () => {
		assert(chainResponse !== null, "No response to validate");
		const data = (chainResponse as Record<string, unknown>).data || chainResponse;
		const chain = (data as Record<string, unknown>).chain as Array<Record<string, unknown>>;

		for (let i = 0; i < chain.length; i++) {
			assert(
				chain[i].order === i + 1,
				`Entry ${i}: expected order ${i + 1}, got ${chain[i].order}`,
			);
		}
	});

	await test("Origin is preserved through the chain", async () => {
		assert(chainResponse !== null, "No response to validate");
		const data = (chainResponse as Record<string, unknown>).data || chainResponse;
		const origin = (data as Record<string, unknown>).origin;
		assert(
			origin === "blok-cross-runtime-test",
			`Expected origin "blok-cross-runtime-test", got "${origin}"`,
		);
	});
}

// ---------------------------------------------------------------------------
// Individual SDK chain-test node validation
// ---------------------------------------------------------------------------

async function runIndividualSdkTests(): Promise<void> {
	console.log("\n--- Individual SDK chain-test Node Tests ---");

	for (const sdk of SDK_CONTAINERS) {
		await test(`${sdk.name} chain-test node works standalone`, async () => {
			const req = {
				node: { name: "chain-test", type: "default", config: {} },
				context: {
					id: "test",
					workflow_name: "test",
					workflow_path: "/test",
					request: {
						body: {
							chain: [{ language: "test", order: 1, timestamp: new Date().toISOString() }],
							origin: "standalone-test",
						},
						headers: {},
						params: {},
						query: {},
						method: "POST",
						url: "/test",
						cookies: {},
						baseUrl: "",
					},
					response: { data: null, contentType: "application/json", success: true, error: null },
					vars: {},
					env: {},
				},
			};

			const res = await fetch(`${sdk.url}/execute`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(req),
				signal: AbortSignal.timeout(10000),
			});

			const body = await res.json() as Record<string, unknown>;
			assert(body.success === true, `${sdk.name} chain-test failed: ${JSON.stringify(body)}`);
			assert(body.data !== null, `${sdk.name} returned null data`);

			const data = body.data as Record<string, unknown>;
			assert(Array.isArray(data.chain), `${sdk.name} chain is not an array`);
			assert(
				(data.chain as unknown[]).length === 2,
				`${sdk.name} should have 2 entries, got ${(data.chain as unknown[]).length}`,
			);
			assert(
				data.origin === "standalone-test",
				`${sdk.name} origin mismatch: ${data.origin}`,
			);
		});
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	console.log("==========================================================");
	console.log("   Blok Cross-Runtime Chain E2E Test");
	console.log("   Testing 8 languages: NodeJS, Go, Rust, Java, C#, PHP, Ruby, Python3");
	console.log("==========================================================");

	// Phase 1: Health checks
	await checkSdkHealth();

	// Phase 2: Individual SDK node tests
	await runIndividualSdkTests();

	// Phase 3: Check Blok server
	await checkBlokHealth();

	// Phase 4: Full chain test
	await runChainTest();

	// Summary
	console.log("\n==========================================================");
	console.log(`Results: ${passed} passed, ${failed} failed`);

	if (failures.length > 0) {
		console.log("\nFailures:");
		for (const f of failures) {
			console.log(f);
		}
	}

	console.log("");
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(2);
});
