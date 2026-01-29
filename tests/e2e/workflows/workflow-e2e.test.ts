/**
 * Workflow E2E Test Runner
 *
 * Tests all workflow JSON files in triggers/http/workflows/json/ by making
 * real HTTP requests against a running Blok server. Auto-detects available
 * infrastructure (PostgreSQL, Python3 SDK, MongoDB, runtime SDKs) and skips
 * tests that require unavailable services.
 *
 * Prerequisites:
 *   1. Blok HTTP server running on port 4000
 *   2. (Optional) PostgreSQL with dvdrental:  docker compose up -d
 *   3. (Optional) Python3 SDK on port 9007
 *   4. (Optional) Runtime SDK containers on ports 9001-9006
 *
 * Usage:
 *   npx tsx workflow-e2e.test.ts
 *
 * Environment variables:
 *   BLOK_URL          - Blok server URL (default: http://localhost:4000)
 *   PYTHON3_SDK_URL   - Python3 SDK URL (default: http://localhost:9007)
 *   SKIP_EXTERNAL_API - Set to "true" to skip tests requiring internet
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BLOK_URL = process.env.BLOK_URL || "http://localhost:4000";
const PYTHON3_SDK_URL = process.env.PYTHON3_SDK_URL || "http://localhost:9007";
const SKIP_EXTERNAL_API = process.env.SKIP_EXTERNAL_API === "true";
const REQUEST_TIMEOUT = 15_000;

// ---------------------------------------------------------------------------
// Infrastructure state (auto-detected)
// ---------------------------------------------------------------------------

const infra = {
	blok: false,
	postgres: false,
	python3: false,
	mongodb: false,
	runtimeSdks: false,
};

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

interface TestResult {
	name: string;
	status: "passed" | "failed" | "skipped";
	reason?: string;
	duration?: number;
}

const results: TestResult[] = [];

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

async function test(
	name: string,
	fn: () => Promise<void>,
	options?: { skip?: boolean; skipReason?: string },
): Promise<void> {
	if (options?.skip) {
		results.push({ name, status: "skipped", reason: options.skipReason });
		return;
	}

	const start = performance.now();
	try {
		await fn();
		const duration = Math.round(performance.now() - start);
		results.push({ name, status: "passed", duration });
	} catch (err: unknown) {
		const duration = Math.round(performance.now() - start);
		const reason = (err as Error).message;
		results.push({ name, status: "failed", reason, duration });
	}
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function httpGet(
	path: string,
	query?: Record<string, string>,
): Promise<{ status: number; contentType: string; body: unknown; raw: string }> {
	const url = new URL(path, BLOK_URL);
	if (query) {
		for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
	}
	const res = await fetch(url.toString(), {
		method: "GET",
		signal: AbortSignal.timeout(REQUEST_TIMEOUT),
	});
	const raw = await res.text();
	const contentType = res.headers.get("content-type") || "";
	let body: unknown = raw;
	if (contentType.includes("application/json")) {
		try {
			body = JSON.parse(raw);
		} catch {
			body = raw;
		}
	}
	return { status: res.status, contentType, body, raw };
}

async function httpPost(
	path: string,
	data: unknown,
): Promise<{ status: number; contentType: string; body: unknown; raw: string }> {
	const url = new URL(path, BLOK_URL);
	const res = await fetch(url.toString(), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(data),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT),
	});
	const raw = await res.text();
	const contentType = res.headers.get("content-type") || "";
	let body: unknown = raw;
	if (contentType.includes("application/json")) {
		try {
			body = JSON.parse(raw);
		} catch {
			body = raw;
		}
	}
	return { status: res.status, contentType, body, raw };
}

async function isReachable(url: string, timeout = 3000): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
		return res.status < 500 || res.status === 500; // any response = reachable
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Infrastructure detection
// ---------------------------------------------------------------------------

async function detectInfrastructure(): Promise<void> {
	console.log("\n--- Infrastructure Detection ---\n");

	// Blok server
	infra.blok = await isReachable(`${BLOK_URL}/health-check`);
	console.log(`  ${infra.blok ? "+" : "-"} Blok server at ${BLOK_URL}`);

	// PostgreSQL — check via the films workflow (which runs a simple SELECT)
	try {
		const res = await fetch(`${BLOK_URL}/films`, {
			signal: AbortSignal.timeout(10000),
		});
		const text = await res.text();
		if (res.status === 200 && text.includes('"data"')) {
			infra.postgres = true;
		} else if (text.includes("does not exist") || text.includes("connect")) {
			// Server reached PostgreSQL but DB/table doesn't exist yet or connection issue
			infra.postgres = false;
		}
	} catch {
		infra.postgres = false;
	}
	console.log(`  ${infra.postgres ? "+" : "-"} PostgreSQL (dvdrental)`);

	// Python3 SDK
	infra.python3 = await isReachable(`${PYTHON3_SDK_URL}/health`);
	console.log(`  ${infra.python3 ? "+" : "-"} Python3 SDK at ${PYTHON3_SDK_URL}`);

	// MongoDB (check env or try a simple workflow)
	if (process.env.MONGODB_URI) {
		infra.mongodb = true;
	}
	console.log(`  ${infra.mongodb ? "+" : "-"} MongoDB`);

	// Runtime SDKs (check if all are available)
	const sdkPorts = [9001, 9002, 9003, 9004, 9005, 9006];
	const sdkChecks = await Promise.all(sdkPorts.map((port) => isReachable(`http://localhost:${port}/health`)));
	infra.runtimeSdks = sdkChecks.every(Boolean) && infra.python3;
	console.log(`  ${infra.runtimeSdks ? "+" : "-"} All runtime SDKs (Go, Rust, Java, C#, PHP, Ruby, Python3)`);

	console.log("");
}

// ---------------------------------------------------------------------------
// Workflow test definitions
// ---------------------------------------------------------------------------

async function testEmptyWorkflow(): Promise<void> {
	console.log("\n--- Workflow: empty ---");
	await test("GET /empty returns 500 (no steps — expected)", async () => {
		const { status, body } = await httpGet("/empty");
		assert(status === 500, `Expected 500, got ${status}`);
		const data = body as Record<string, unknown>;
		assert(
			typeof data.error === "string" && data.error.includes("at least one step"),
			`Expected 'at least one step' error, got: ${JSON.stringify(data)}`,
		);
	});
}

async function testLoadtestWorkflow(): Promise<void> {
	console.log("\n--- Workflow: loadtest ---");
	await test("GET /loadtest returns 200 with {success: true}", async () => {
		const { status, body } = await httpGet("/loadtest");
		assert(status === 200, `Expected 200, got ${status}`);
		const data = body as Record<string, unknown>;
		assert(data.success === true, `Expected success=true, got ${JSON.stringify(data)}`);
	});
}

async function testCountriesWorkflow(): Promise<void> {
	console.log("\n--- Workflow: countries ---");
	await test(
		"GET /countries returns 200 with JSON data",
		async () => {
			const { status, contentType, body } = await httpGet("/countries");
			assert(status === 200, `Expected 200, got ${status}`);
			assert(contentType.includes("json"), `Expected JSON, got ${contentType}`);
			assert(body !== null && body !== undefined, "Response body is null");
		},
		{ skip: SKIP_EXTERNAL_API, skipReason: "SKIP_EXTERNAL_API=true" },
	);
}

async function testCountriesPyWorkflow(): Promise<void> {
	console.log("\n--- Workflow: countries-py ---");
	await test(
		"GET /countries-py returns 200 via Python3 SDK",
		async () => {
			const { status, body } = await httpGet("/countries-py");
			assert(status === 200, `Expected 200, got ${status}. Body: ${JSON.stringify(body)}`);
		},
		{ skip: !infra.python3, skipReason: "Python3 SDK not available" },
	);
}

async function testCountriesVsFactsWorkflow(): Promise<void> {
	console.log("\n--- Workflow: countries-vs-facts ---");
	await test(
		"GET /countries-vs-facts returns cat facts by default",
		async () => {
			const { status, contentType, body } = await httpGet("/countries-vs-facts");
			assert(status === 200, `Expected 200, got ${status}`);
			assert(contentType.includes("json"), `Expected JSON, got ${contentType}`);
			assert(body !== null, "Response body is null");
		},
		{ skip: SKIP_EXTERNAL_API, skipReason: "SKIP_EXTERNAL_API=true" },
	);
	await test(
		"GET /countries-vs-facts?countries=true returns countries data",
		async () => {
			const { status, contentType } = await httpGet("/countries-vs-facts", { countries: "true" });
			assert(status === 200, `Expected 200, got ${status}`);
			assert(contentType.includes("json"), `Expected JSON, got ${contentType}`);
		},
		{ skip: SKIP_EXTERNAL_API, skipReason: "SKIP_EXTERNAL_API=true" },
	);
}

async function testLaunchesByYearWorkflow(): Promise<void> {
	console.log("\n--- Workflow: launches-by-year ---");
	await test(
		"GET /launches-by-year returns 200 with launch data",
		async () => {
			const { status, contentType } = await httpGet("/launches-by-year");
			assert(status === 200, `Expected 200, got ${status}`);
			assert(contentType.includes("json"), `Expected JSON, got ${contentType}`);
		},
		{ skip: SKIP_EXTERNAL_API, skipReason: "SKIP_EXTERNAL_API=true" },
	);
}

async function testFilmsWorkflow(): Promise<void> {
	console.log("\n--- Workflow: films ---");
	await test(
		"GET /films returns 200 with film data from PostgreSQL",
		async () => {
			const { status, body } = await httpGet("/films");
			assert(status === 200, `Expected 200, got ${status}`);
			const data = body as Record<string, unknown>;
			assert(typeof data.total === "number", `Expected total to be a number, got ${typeof data.total}`);
			assert(Array.isArray(data.data), "Expected data to be an array");
			assert((data.data as unknown[]).length > 0, "Expected at least 1 film");
		},
		{ skip: !infra.postgres, skipReason: "PostgreSQL not available" },
	);
}

async function testDbManagerWorkflow(): Promise<void> {
	console.log("\n--- Workflow: db-manager ---");

	await test(
		"GET /db-manager returns HTML UI",
		async () => {
			const { status, contentType } = await httpGet("/db-manager");
			assert(status === 200, `Expected 200, got ${status}`);
			assert(contentType.includes("text/html"), `Expected HTML, got ${contentType}`);
		},
		{ skip: !infra.postgres, skipReason: "PostgreSQL not available" },
	);

	await test(
		"GET /db-manager/tables returns table list from PostgreSQL",
		async () => {
			const { status, body } = await httpGet("/db-manager/tables");
			assert(status === 200, `Expected 200, got ${status}`);
			const data = body as Record<string, unknown>;
			assert(typeof data.total === "number", `Expected total, got ${JSON.stringify(data).slice(0, 200)}`);
			assert(Array.isArray(data.data), "Expected data to be an array");
			assert((data.data as unknown[]).length > 0, "Expected at least 1 table");
		},
		{ skip: !infra.postgres, skipReason: "PostgreSQL not available" },
	);
}

async function testDashboardGenWorkflow(): Promise<void> {
	console.log("\n--- Workflow: dashboard-gen ---");

	await test(
		"GET /dashboard-gen returns HTML UI",
		async () => {
			const { status, contentType } = await httpGet("/dashboard-gen");
			assert(status === 200, `Expected 200, got ${status}`);
			assert(contentType.includes("text/html"), `Expected HTML, got ${contentType}`);
		},
		{ skip: !infra.postgres, skipReason: "PostgreSQL not available" },
	);

	await test(
		"GET /dashboard-gen/dashboards returns empty dashboard list",
		async () => {
			const { status } = await httpGet("/dashboard-gen/dashboards");
			assert(status === 200, `Expected 200, got ${status}`);
		},
		{ skip: !infra.postgres, skipReason: "PostgreSQL not available" },
	);
}

async function testMongodbWorkflow(): Promise<void> {
	console.log("\n--- Workflow: mongodb ---");

	await test(
		"GET /mongodb/test_collection returns MongoDB data",
		async () => {
			const { status } = await httpGet("/mongodb/test_collection");
			assert(status === 200, `Expected 200, got ${status}`);
		},
		{ skip: !infra.mongodb, skipReason: "MongoDB not available" },
	);
}

async function testFeedbackWorkflow(): Promise<void> {
	console.log("\n--- Workflow: feedback ---");

	await test("GET /feedback returns HTML UI", async () => {
		const { status, contentType } = await httpGet("/feedback");
		assert(status === 200, `Expected 200, got ${status}`);
		assert(contentType.includes("text/html"), `Expected HTML, got ${contentType}`);
	});

	await test("GET /feedback/all returns feedback list (JSON)", async () => {
		const { status, contentType } = await httpGet("/feedback/all");
		assert(status === 200, `Expected 200, got ${status}`);
		assert(contentType.includes("json"), `Expected JSON, got ${contentType}`);
	});
}

async function testImageCaptureWorkflow(): Promise<void> {
	console.log("\n--- Workflow: image-capture ---");

	await test("GET /image-capture returns HTML UI", async () => {
		const { status, contentType } = await httpGet("/image-capture");
		assert(status === 200, `Expected 200, got ${status}`);
		assert(contentType.includes("text/html"), `Expected HTML, got ${contentType}`);
	});
}

async function testRentalsPdfWorkflow(): Promise<void> {
	console.log("\n--- Workflow: rentals-pdf ---");

	await test(
		"GET /rentals-pdf returns PDF from PostgreSQL data",
		async () => {
			const { status } = await httpGet("/rentals-pdf");
			assert(status === 200, `Expected 200, got ${status}`);
		},
		{
			skip: !infra.postgres || !infra.python3,
			skipReason: !infra.postgres ? "PostgreSQL not available" : "Python3 SDK not available",
		},
	);
}

async function testWorkflowDocsWorkflow(): Promise<void> {
	console.log("\n--- Workflow: workflow-docs ---");

	await test("GET /workflow-docs returns HTML UI", async () => {
		const { status, contentType } = await httpGet("/workflow-docs");
		assert(status === 200, `Expected 200, got ${status}`);
		assert(contentType.includes("text/html"), `Expected HTML, got ${contentType}`);
	});

	await test("GET /workflow-docs/workflows returns JSON list of workflows", async () => {
		const { status, body } = await httpGet("/workflow-docs/workflows");
		assert(status === 200, `Expected 200, got ${status}`);
		const data = body as Record<string, unknown>;
		assert(
			Array.isArray(data.files) || Array.isArray(data.data),
			`Expected files or data array, got ${JSON.stringify(data).slice(0, 200)}`,
		);
		const files = (data.files || data.data) as unknown[];
		assert(files.length > 0, "Expected at least 1 workflow file");
	});
}

async function testCrossRuntimeChainWorkflow(): Promise<void> {
	console.log("\n--- Workflow: cross-runtime-chain ---");

	await test(
		"POST /cross-runtime-chain validates all 8 runtimes",
		async () => {
			const { status, body } = await httpPost("/cross-runtime-chain", {});
			assert(status === 200, `Expected 200, got ${status}`);
			const data = body as Record<string, unknown>;
			const chain = data.chain as Array<Record<string, unknown>> | undefined;
			assert(Array.isArray(chain), `Expected chain array, got ${JSON.stringify(data).slice(0, 300)}`);
			assert(chain!.length === 8, `Expected 8 entries, got ${chain!.length}`);

			const expectedLangs = ["nodejs", "go", "rust", "java", "csharp", "php", "ruby", "python3"];
			const actualLangs = chain!.map((e) => e.language);
			for (let i = 0; i < expectedLangs.length; i++) {
				assert(
					actualLangs[i] === expectedLangs[i],
					`Entry ${i}: expected "${expectedLangs[i]}", got "${actualLangs[i]}"`,
				);
			}
		},
		{ skip: !infra.runtimeSdks, skipReason: "Not all runtime SDKs available" },
	);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary(): void {
	const passed = results.filter((r) => r.status === "passed");
	const failed = results.filter((r) => r.status === "failed");
	const skipped = results.filter((r) => r.status === "skipped");

	console.log("\n==========================================================");
	console.log("   WORKFLOW E2E TEST RESULTS");
	console.log("==========================================================\n");

	// Passed
	if (passed.length > 0) {
		for (const r of passed) {
			console.log(`  \x1b[32m✓\x1b[0m ${r.name} \x1b[90m(${r.duration}ms)\x1b[0m`);
		}
	}

	// Failed
	if (failed.length > 0) {
		console.log("");
		for (const r of failed) {
			console.log(`  \x1b[31m✗\x1b[0m ${r.name} \x1b[90m(${r.duration}ms)\x1b[0m`);
			console.log(`    \x1b[31m${r.reason}\x1b[0m`);
		}
	}

	// Skipped
	if (skipped.length > 0) {
		console.log("");
		for (const r of skipped) {
			console.log(`  \x1b[33m○\x1b[0m ${r.name} \x1b[90m(${r.reason})\x1b[0m`);
		}
	}

	// Summary line
	console.log("\n----------------------------------------------------------");
	console.log(
		`  \x1b[32m${passed.length} passed\x1b[0m  ` +
			`\x1b[31m${failed.length} failed\x1b[0m  ` +
			`\x1b[33m${skipped.length} skipped\x1b[0m  ` +
			`(${results.length} total)`,
	);
	console.log("----------------------------------------------------------\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	console.log("==========================================================");
	console.log("   Blok Workflow E2E Test Suite");
	console.log("   Testing all 15 workflow files");
	console.log("==========================================================");

	// Phase 1: Detect available infrastructure
	await detectInfrastructure();

	if (!infra.blok) {
		console.error(`\n  ERROR: Blok server is not reachable at ${BLOK_URL}`);
		console.error("  Start it first:  cd triggers/http && pnpm dev\n");
		process.exit(2);
	}

	// Phase 2: Run all workflow tests
	// Tier 1 — No external dependencies
	await testEmptyWorkflow();
	await testLoadtestWorkflow();

	// Tier 2 — External APIs (internet required)
	await testCountriesWorkflow();
	await testCountriesVsFactsWorkflow();
	await testLaunchesByYearWorkflow();

	// Tier 3 — PostgreSQL
	await testFilmsWorkflow();
	await testDbManagerWorkflow();
	await testDashboardGenWorkflow();
	await testRentalsPdfWorkflow();

	// Tier 4 — Python3 SDK
	await testCountriesPyWorkflow();
	await testFeedbackWorkflow();
	await testImageCaptureWorkflow();

	// Tier 5 — MongoDB
	await testMongodbWorkflow();

	// Tier 6 — UI-only nodes (filesystem)
	await testWorkflowDocsWorkflow();

	// Tier 7 — All runtime SDKs
	await testCrossRuntimeChainWorkflow();

	// Phase 3: Print summary
	printSummary();

	const failed = results.filter((r) => r.status === "failed").length;
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(2);
});
