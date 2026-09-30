/**
 * A scaffolded project (`blokctl create project --triggers http,mcp`) with an
 * MCP-only TypeScript workflow under `src/workflows/` exposed ZERO tools: the
 * file scan saw it ("non-HTTP triggers this boot: mcp=1"), but
 * `buildFileBasedRoutes()` fed the WorkflowRegistry from the HTTP route table
 * only, so `McpTrigger.registerRoutesFromRegistry()` — which walks that
 * registry — logged "no workflows with trigger.mcp found".
 *
 * Boots the real HttpTrigger + a same-app McpTrigger (the mounted layout the
 * scaffold generates) against a temp project whose only workflow is MCP-only
 * and on disk only (no `Workflows.ts` entry).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { makeOtelApiMock } = await vi.hoisted(() => import("../helpers/otel-api-mock.js"));
vi.mock("@opentelemetry/api", () => makeOtelApiMock());

vi.mock("../../src/runner/metrics/opentelemetry_metrics", () => ({
	bootstrapMetrics: async () => ({ meter: {}, metricsHandler: () => {} }),
	resetBootstrap: () => {},
	metricsHandler: vi.fn(),
}));
vi.mock("../../src/Nodes", () => ({ default: {} }));
vi.mock("../../src/Workflows", () => ({ default: {} }));
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
import McpTrigger from "@blokjs/trigger-mcp";
import { Hono } from "hono";
import HttpTrigger, { type AppBindings } from "../../src/runner/HttpTrigger.js";

// The `workflow()` builder shape (`_blokV2` + `_config`) with no imports, so
// the fixture loads from a temp dir outside the workspace.
const MCP_ONLY_WORKFLOW = `export default {
	_blokV2: true,
	_config: {
		name: "mcp-greeter",
		version: "1.0.0",
		trigger: { mcp: { path: "/mcp", serverName: "blok-test", tool: { name: "greet" } } },
		steps: [{ id: "greet", use: "@blokjs/respond", inputs: {} }],
	},
};
`;

describe("HttpTrigger — non-HTTP-triggered scanned workflows reach the WorkflowRegistry", () => {
	let projectDir: string;
	const ORIGINAL_ENV = { ...process.env };

	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		RoutingDiagnostics.resetInstance();
		projectDir = mkdtempSync(join(tmpdir(), "blok-mcp-only-"));
		mkdirSync(join(projectDir, "src", "workflows", "tools"), { recursive: true });
		writeFileSync(join(projectDir, "src", "workflows", "tools", "greet.ts"), MCP_ONLY_WORKFLOW);
		vi.spyOn(process, "cwd").mockReturnValue(projectDir);
		process.env.WORKFLOWS_PATH = join(projectDir, "workflows");
		process.env.BLOK_FILE_BASED_ROUTING = "true";
		process.env.BLOK_HMR = "false";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.env = { ...ORIGINAL_ENV };
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("an MCP-only TS workflow on disk is exposed as an MCP tool", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const app = new Hono<AppBindings>();
		const http = new HttpTrigger(app);
		const mcp = new McpTrigger(app, http);
		mcp.setNodeMap(http.getNodeMap());
		await mcp.listen();
		await http.listen();
		const logged = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
		await mcp.stop();

		expect(WorkflowRegistry.getInstance().get("mcp-greeter")?.sourcePath).toBe(
			join(projectDir, "src", "workflows", "tools", "greet.ts"),
		);
		expect(logged).not.toContain("no workflows with trigger.mcp found");
		// The group exists only because `mcp-greeter` reached the registry; the
		// count also includes the dev-only Inertia builtin tools (#1019).
		const tools = Number(logged.match(/server \\?"blok-test\\?" at \/mcp — (\d+) tool\(s\)/)?.[1] ?? 0);
		expect(tools).toBeGreaterThanOrEqual(1);
	});
});
