/**
 * ADR 0015 (#678) — the HTTP half of the trigger-boundary input gate.
 *
 * `TriggerBase.run()` safeParses `ctx.request.body` against the workflow's
 * declared `input` Zod (read live off the WorkflowRegistry entry) and REPLACES
 * the body with the parsed value. This suite drives the real Hono app so the
 * assertions are on what a client actually sees:
 *
 *  - valid body   → 200, Zod defaults applied + unknown keys stripped
 *  - invalid body → 400 with the structured `validation_errors` body naming the
 *                   workflow and the offending field (the error-translation seam
 *                   that already renders ConcurrencyLimitError et al.)
 *  - no declared `input` → gate is a no-op, body reaches the node verbatim
 *  - BLOK_VALIDATE_WORKFLOW_INPUT=0 → kill switch, malformed body passes through
 *
 * Mirrors the harness of `HttpTrigger.headers.test.ts` (the sibling 400-class
 * entry gate): mock the OTel/metrics/server surface, leave `../../src/Nodes`
 * REAL so `@blokjs/respond` resolves, and mock `../../src/Workflows` with the
 * fixture workflows.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { makeOtelApiMock } = await vi.hoisted(() => import("../helpers/otel-api-mock.js"));
vi.mock("@opentelemetry/api", () => makeOtelApiMock());

vi.mock("../../src/runner/metrics/opentelemetry_metrics", () => ({
	bootstrapMetrics: async () => ({ meter: {}, metricsHandler: () => {} }),
	resetBootstrap: () => {},
	metricsHandler: vi.fn(),
}));
vi.mock("../../src/AppRoutes", () => {
	const { Hono } = require("hono");
	return { default: new Hono() };
});

// Two fixtures: one declaring an `input` schema, one declaring none (the
// zero-cost path). `@trigger` structurally references the request body, so the
// node echoes exactly what the gate left on `ctx.request.body`.
vi.mock("../../src/Workflows", () => {
	const { z } = require("zod");
	const echoTriggerBody = {
		id: "out",
		use: "@blokjs/respond",
		inputs: { body: { $ref: { step: "@trigger", path: ["body"] } } },
	};
	return {
		default: {
			search: {
				_blokV2: true,
				_config: {
					name: "search",
					version: "1.0.0",
					trigger: { http: { method: "POST", path: "/search" } },
					input: z.object({ query: z.string(), page: z.number().default(1) }),
					steps: [echoTriggerBody],
				},
			},
			open: {
				_blokV2: true,
				_config: {
					name: "open",
					version: "1.0.0",
					trigger: { http: { method: "POST", path: "/open" } },
					steps: [echoTriggerBody],
				},
			},
		},
	};
});

const mockServer = { close: vi.fn(), on: vi.fn() };
vi.mock("@hono/node-server", () => ({
	serve: vi.fn((_opts: any, cb: any) => {
		if (cb) cb();
		return mockServer;
	}),
}));
vi.mock("@hono/node-server/serve-static", () => ({ serveStatic: () => vi.fn() }));
vi.mock("@hono/node-server/utils/response", () => ({ RESPONSE_ALREADY_SENT: new Response(null) }));

import { WorkflowRegistry } from "@blokjs/runner";
import HttpTrigger from "../../src/runner/HttpTrigger.js";

async function post(path: string, body: unknown) {
	const trigger = new HttpTrigger();
	await trigger.listen();
	return trigger.getApp().fetch(
		new Request(`http://localhost${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

describe("HttpTrigger — declared workflow input enforcement (ADR 0015)", () => {
	const priorFlag = process.env.BLOK_VALIDATE_WORKFLOW_INPUT;

	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
		// biome-ignore lint/performance/noDelete: env reset must reach `undefined`, not "undefined".
		if (priorFlag === undefined) delete process.env.BLOK_VALIDATE_WORKFLOW_INPUT;
		else process.env.BLOK_VALIDATE_WORKFLOW_INPUT = priorFlag;
	});

	it("valid body → 200 with Zod defaults applied and unknown keys stripped", async () => {
		const res = await post("/search", { query: "hi", nope: "dropped" });

		expect(res.status).toBe(200);
		// `page` was never sent — the advertised `.default(1)` is now real at runtime.
		expect(await res.json()).toEqual({ query: "hi", page: 1 });
	});

	it("invalid body → 400 with structured validation_errors naming the workflow and field", async () => {
		const res = await post("/search", { page: "not-a-number" });

		expect(res.status).toBe(400);
		const json = (await res.json()) as {
			error?: string;
			workflowName?: string;
			validation_errors?: Array<{ path: string[]; message: string; code: string }>;
		};
		expect(json.error).toBe("Input validation failed");
		expect(json.workflowName).toBe("search");
		const paths = (json.validation_errors ?? []).map((e) => e.path.join("."));
		expect(paths).toContain("query"); // missing required
		expect(paths).toContain("page"); // wrong type
	});

	it("workflow with NO declared input → gate is a no-op, body reaches the node verbatim", async () => {
		const res = await post("/open", { anything: true, nested: { ok: 1 } });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ anything: true, nested: { ok: 1 } });
	});

	it("kill switch BLOK_VALIDATE_WORKFLOW_INPUT=0 lets a malformed body through unparsed", async () => {
		process.env.BLOK_VALIDATE_WORKFLOW_INPUT = "0";
		const res = await post("/search", { page: "not-a-number" });

		expect(res.status).toBe(200);
		// No gate → raw body, no defaults, nothing stripped.
		expect(await res.json()).toEqual({ page: "not-a-number" });
	});
});
