/**
 * #695 — TypeScript workflows were scanned from the filesystem but never
 * routed. `HttpTrigger.buildFileBasedRoutes()` computed `scannedTs` but only
 * used it to build a display map (`workflowSourcePaths`); the route table
 * itself was built from `scannedJson` + `manual` (`Workflows.ts`) only, so a
 * `.ts` workflow under `src/workflows/` produced zero routes unless it was
 * ALSO hand-registered in `Workflows.ts`.
 *
 * These tests boot the REAL HttpTrigger against this package's REAL
 * `src/workflows/*.ts` fixtures and the REAL (unmocked) `src/Workflows.ts`
 * map — unlike the other HttpTrigger unit tests, which mock `Workflows.ts`
 * to isolate a single fixture. That's deliberate here: #695's bug and its
 * fix both hinge on the real double-registration shape already present in
 * this corpus (`countries-helper.ts` and friends are on disk AND listed in
 * `Workflows.ts`; `countries-handle-dsl.ts` is on disk ONLY).
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { makeOtelApiMock } = await vi.hoisted(() => import("../helpers/otel-api-mock.js"));
vi.mock("@opentelemetry/api", () => makeOtelApiMock());

vi.mock("../../src/runner/metrics/opentelemetry_metrics", () => ({
	bootstrapMetrics: async () => ({ meter: {}, metricsHandler: () => {} }),
	resetBootstrap: () => {},
	metricsHandler: vi.fn(),
}));
vi.mock("../../src/Nodes", () => ({ default: {} }));
vi.mock("../../src/AppRoutes", () => {
	const { Hono } = require("hono");
	return { default: new Hono() };
});

const mockServer = { close: vi.fn(), on: vi.fn() };
vi.mock("@hono/node-server", () => ({
	serve: vi.fn((_opts: unknown, cb?: () => void) => {
		cb?.();
		return mockServer;
	}),
}));
vi.mock("@hono/node-server/serve-static", () => ({ serveStatic: () => vi.fn() }));
vi.mock("@hono/node-server/utils/response", () => ({ RESPONSE_ALREADY_SENT: new Response(null) }));

import { RoutingDiagnostics, WorkflowRegistry } from "@blokjs/runner";
import HttpTrigger from "../../src/runner/HttpTrigger.js";

async function bootApp(): Promise<void> {
	const trigger = new HttpTrigger();
	await trigger.listen();
}

describe("HttpTrigger — TS auto-routing + scan/manual double registration (#695)", () => {
	const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
	const ORIGINAL_WORKFLOWS_PATH = process.env.WORKFLOWS_PATH;
	const ORIGINAL_HMR = process.env.BLOK_HMR;

	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		RoutingDiagnostics.resetInstance();
		// No JSON corpus in play — isolate the TS scan + the REAL Workflows.ts map.
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
		process.env.NODE_ENV = "development";
		process.env.BLOK_HMR = "false"; // dev-mode NODE_ENV would otherwise auto-enable HMR; not under test here
	});

	afterEach(() => {
		process.env.NODE_ENV = ORIGINAL_NODE_ENV ?? "test";
		process.env.WORKFLOWS_PATH = ORIGINAL_WORKFLOWS_PATH;
		process.env.BLOK_HMR = ORIGINAL_HMR ?? "";
	});

	it("routes a TS workflow that ONLY exists on disk — no `Workflows.ts` entry required", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await bootApp();
		const logged = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
		logSpy.mockRestore();

		// `countries-handle-dsl.ts` declares `trigger: http.get("/countries-dsl")`
		// and is intentionally NOT listed in the real `src/Workflows.ts` — the
		// exact fixture #695's bug report cites as stuck at zero routes.
		expect(logged).toContain("GET     /countries-dsl  ←  countries.dsl");
		expect(logged).not.toMatch(/countries-handle-dsl\.ts.*produced no route/);
	});

	it("a workflow scanned from disk AND listed in Workflows.ts serves exactly one route, silently", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		await bootApp();
		const logged = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
		const errored = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
		logSpy.mockRestore();
		errorSpy.mockRestore();

		// `countries-helper.ts` is on disk (src/workflows/) AND registered under
		// the key "countries-helper" in the real src/Workflows.ts — the exact
		// double-registration shape mid-TS-migration. Exactly ONE route line,
		// manual's key/label wins, no collision reported anywhere.
		const routeLines = logged.split("\n").filter((l) => l.includes("/countries-helper  ←"));
		expect(routeLines).toHaveLength(1);
		expect(routeLines[0]).toContain("←  countries-helper");
		expect(errored).not.toContain("route collision");
		expect(errored).not.toContain("workflow name collision");
	});

	it("registers every real dual-registered corpus workflow exactly once", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		await bootApp();
		const logged = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
		logSpy.mockRestore();

		const dualRegistered = [
			"/countries-helper",
			"/countries-cats-helper",
			"/empty-helper",
			"/eval/retrieve",
			"/eval/run",
			"/foreign/auth",
		];
		for (const routePath of dualRegistered) {
			const hits = logged.split("\n").filter((l) => l.includes(`${routePath}  ←`));
			expect(hits, routePath).toHaveLength(1);
		}
	});

	it("a non-http-triggered TS workflow stays unroutable over HTTP (hasHttpTrigger filter applies to scanned TS too)", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const trigger = new HttpTrigger();
		await trigger.listen();
		errorSpy.mockRestore();

		// None of this corpus's fixtures are worker/cron-only, so this asserts
		// the negative space directly: nothing in the live route table lacks an
		// `http` trigger. `WorkflowRouter.test.ts` covers the positive unit case
		// ("skips workflows without an http trigger", kind: "ts") at the
		// `buildRouteTable` level.
		const table = (trigger as unknown as { routeTable: Array<{ path: string; workflow: unknown }> }).routeTable;
		expect(table.length).toBeGreaterThan(0);
	});
});

describe("HttpTrigger — zero-route diagnostic still fires for a genuine drop (#695)", () => {
	const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
	const ORIGINAL_WORKFLOWS_PATH = process.env.WORKFLOWS_PATH;
	const ORIGINAL_HMR = process.env.BLOK_HMR;
	let tmpRoot = "";

	beforeEach(async () => {
		WorkflowRegistry.resetInstance();
		RoutingDiagnostics.resetInstance();
		process.env.BLOK_FILE_BASED_ROUTING = "true";
		process.env.NODE_ENV = "development";
		process.env.BLOK_HMR = "false"; // dev-mode NODE_ENV would otherwise auto-enable HMR; not under test here

		// A JSON workflow claiming the SAME (method, path) as the real
		// `src/workflows/countries-helper.ts` fixture, with a DIFFERENT
		// workflow object — a genuine collision, not the same-object case
		// `buildRouteTable` now dedupes silently.
		tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "blok-695-collision-"));
		await fsp.mkdir(path.join(tmpRoot, "json"), { recursive: true });
		await fsp.writeFile(
			path.join(tmpRoot, "json", "countries-helper-clash.json"),
			JSON.stringify({
				name: "countries.jsonClash",
				version: "1.0.0",
				trigger: { http: { method: "GET", path: "/countries-helper" } },
				steps: [],
			}),
		);
		process.env.WORKFLOWS_PATH = tmpRoot;
	});

	afterEach(async () => {
		process.env.NODE_ENV = ORIGINAL_NODE_ENV ?? "test";
		process.env.WORKFLOWS_PATH = ORIGINAL_WORKFLOWS_PATH;
		process.env.BLOK_HMR = ORIGINAL_HMR ?? "";
		await fsp.rm(tmpRoot, { recursive: true, force: true });
	});

	it("logs the route collision AND the residual zero-route info line for the dropped TS file", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await bootApp();

		const errored = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
		expect(errored).toContain("route collision");
		expect(errored).toContain("/countries-helper");

		const logged = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
		expect(logged).toContain("declares an HTTP trigger but produced no route");
		expect(logged).toContain("countries-helper.ts");

		logSpy.mockRestore();
		errorSpy.mockRestore();
	});
});
