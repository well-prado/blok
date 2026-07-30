/**
 * OBS-02 B2.1 — inbound W3C `traceparent` extraction.
 *
 * Unlike the other HTTP-trigger unit suites, this file does NOT mock
 * `@opentelemetry/api` — it registers a REAL tracer provider + W3C propagator
 * + context manager + an `InMemorySpanExporter` so we can assert the actual
 * span graph. A request carrying a `traceparent` header must produce a
 * workflow span that JOINS the caller's trace (same traceId, parent =
 * inbound span id) rather than starting a fresh root. AC-B2.1.
 */

import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A trivial workflow: POST /traced → respond. Enough to drive
// `runWorkflowExecution`, which creates + ends the workflow span.
vi.mock("../../src/Workflows", () => {
	const traced = {
		_blokV2: true,
		_config: {
			name: "traced",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/traced" } },
			steps: [{ id: "out", use: "@blokjs/respond", inputs: { body: { ok: true } } }],
		},
	};
	return { default: { traced } };
});

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

import { WorkflowRegistry } from "@blokjs/runner";
import HttpTrigger from "../../src/runner/HttpTrigger";

// A known, valid W3C traceparent: version-traceId-parentSpanId-flags.
const INBOUND_TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const INBOUND_SPAN_ID = "b7ad6b7169203331";
const INBOUND_TRACEPARENT = `00-${INBOUND_TRACE_ID}-${INBOUND_SPAN_ID}-01`;

describe("HttpTrigger — OBS-02 B2.1 inbound traceparent extraction", () => {
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;
	let cm: AsyncLocalStorageContextManager;

	beforeAll(() => {
		exporter = new InMemorySpanExporter();
		provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
		trace.setGlobalTracerProvider(provider);
		propagation.setGlobalPropagator(new W3CTraceContextPropagator());
		cm = new AsyncLocalStorageContextManager().enable();
		context.setGlobalContextManager(cm);
	});

	afterAll(async () => {
		await provider.shutdown();
		cm.disable();
		context.disable();
		trace.disable();
		propagation.disable();
	});

	beforeEach(() => {
		exporter.reset();
		WorkflowRegistry.resetInstance();
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
	});

	async function buildApp() {
		const trigger = new HttpTrigger();
		await trigger.listen();
		return trigger.getApp();
	}

	/** The workflow-level span is the SERVER-kind span named after the workflow. */
	function workflowSpan() {
		return exporter.getFinishedSpans().find((s) => s.name === "traced");
	}

	it("joins the caller's trace when a traceparent header is present", async () => {
		const app = await buildApp();
		const res = await app.fetch(
			new Request("http://localhost/traced", {
				method: "POST",
				headers: { "content-type": "application/json", traceparent: INBOUND_TRACEPARENT },
				body: "{}",
			}),
		);
		expect(res.status).toBe(200);

		const span = workflowSpan();
		expect(span).toBeDefined();
		// Same trace as the caller, and parented under the inbound span.
		expect(span?.spanContext().traceId).toBe(INBOUND_TRACE_ID);
		// OTel 2.x replaced ReadableSpan.parentSpanId with parentSpanContext.
		expect(span?.parentSpanContext?.spanId).toBe(INBOUND_SPAN_ID);
	});

	it("starts a fresh root trace when no traceparent header is present", async () => {
		const app = await buildApp();
		const res = await app.fetch(
			new Request("http://localhost/traced", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		);
		expect(res.status).toBe(200);

		const span = workflowSpan();
		expect(span).toBeDefined();
		// No inbound context → a brand-new root span (no parent).
		expect(span?.parentSpanContext?.spanId).toBeUndefined();
		expect(span?.spanContext().traceId).not.toBe(INBOUND_TRACE_ID);
	});
});
