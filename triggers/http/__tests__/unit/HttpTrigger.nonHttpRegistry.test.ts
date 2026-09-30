/**
 * A scaffolded project (`blokctl create project --triggers http,mcp`) with an
 * MCP-only TypeScript workflow under `src/workflows/` exposed ZERO tools: the
 * file scan saw it ("non-HTTP triggers this boot: mcp=1"), but
 * `buildFileBasedRoutes()` fed the WorkflowRegistry from the HTTP route table
 * only, so `McpTrigger.registerRoutesFromRegistry()` — which walks that
 * registry — logged "no workflows with trigger.mcp found".
 *
 * Boots the real HttpTrigger + same-app WS / SSE / Webhook / MCP triggers (the
 * mounted layout the scaffold generates) against a temp project whose
 * workflows are builder-shaped, non-HTTP-only, and on disk only (no
 * `Workflows.ts` entry).
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
import SSETrigger from "@blokjs/trigger-sse";
import WebhookTrigger from "@blokjs/trigger-webhook";
import WebSocketTrigger from "@blokjs/trigger-websocket";
import { Hono } from "hono";
import HttpTrigger, { type AppBindings } from "../../src/runner/HttpTrigger.js";

// The `workflow()` builder shape (`_blokV2` + `_config`) with no imports, so
// the fixtures load from a temp dir outside the workspace.
const builderWorkflow = (name: string, trigger: unknown) => `export default {
	_blokV2: true,
	_config: {
		name: ${JSON.stringify(name)},
		version: "1.0.0",
		trigger: ${JSON.stringify(trigger)},
		steps: [{ id: "respond", use: "@blokjs/respond", inputs: {} }],
	},
};
`;

const FIXTURES: Record<string, string> = {
	"tools/greet.ts": builderWorkflow("mcp-greeter", {
		mcp: { path: "/mcp", serverName: "blok-test", tool: { name: "greet" } },
	}),
	// v2.5.4 regression: once HttpTrigger registered scanned builders as-is, the
	// WS / SSE / Webhook triggers (which read `trigger` at the top level only)
	// stopped seeing them and the scaffold's /ws/echo never opened.
	"events/echo.ts": builderWorkflow("ws-echo", { websocket: { path: "/ws/echo" } }),
	"events/feed.ts": builderWorkflow("sse-feed", { sse: { path: "/events/feed" } }),
	"hooks/stripe.ts": builderWorkflow("stripe-hook", { webhook: { provider: "stripe" } }),
};

describe("HttpTrigger — non-HTTP-triggered scanned workflows reach the WorkflowRegistry", () => {
	let projectDir: string;
	const ORIGINAL_ENV = { ...process.env };

	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		RoutingDiagnostics.resetInstance();
		projectDir = mkdtempSync(join(tmpdir(), "blok-mcp-only-"));
		for (const [file, source] of Object.entries(FIXTURES)) {
			const target = join(projectDir, "src", "workflows", file);
			mkdirSync(join(target, ".."), { recursive: true });
			writeFileSync(target, source);
		}
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

	it("builder-shaped workflows with only non-HTTP triggers mount on every sibling trigger", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const app = new Hono<AppBindings>();
		const http = new HttpTrigger(app);
		const siblings = [
			new WebSocketTrigger(app, http),
			new SSETrigger(app, http),
			new WebhookTrigger(app, http),
			new McpTrigger(app, http),
		];
		for (const t of siblings) {
			t.setNodeMap(http.getNodeMap());
			await t.listen();
		}
		await http.listen();
		const logged = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
		for (const t of siblings) await t.stop();

		expect(WorkflowRegistry.getInstance().get("mcp-greeter")?.sourcePath).toBe(
			join(projectDir, "src", "workflows", "tools", "greet.ts"),
		);
		expect(logged).not.toContain("no workflows with trigger.mcp found");
		// The group exists only because `mcp-greeter` reached the registry; the
		// count also includes the dev-only Inertia builtin tools (#1019).
		const tools = Number(logged.match(/server \\?"blok-test\\?" at \/mcp — (\d+) tool\(s\)/)?.[1] ?? 0);
		expect(tools).toBeGreaterThanOrEqual(1);
		expect(logged).toMatch(/\[blok\]\[ws\]\s+GET\s+\/ws\/echo\s+←\s+ws-echo/);
		expect(logged).toMatch(/\[blok\]\[sse\]\s+GET\s+\/events\/feed\s+←\s+sse-feed/);
		expect(logged).toMatch(/\[blok\]\[webhook\]\s+POST\s+\/webhooks\/stripe\s+←\s+stripe-hook/);
	});
});
