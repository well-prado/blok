/**
 * OBS-02 B4 (T7) — per-step OTel child spans in RunnerSteps.
 *
 * Registers a REAL tracer provider + InMemorySpanExporter + context manager so
 * we can assert the actual span graph: every executing leaf step produces a
 * child span with blok.step.* attributes; a throwing step's span is ERROR +
 * carries an exception event; and a span created INSIDE a node's run() nests
 * under that step's span (the mechanism that makes B2.2 gRPC spans nest under
 * the step). All no-op when no provider is registered.
 */

import type { Context } from "@blokjs/shared";
import { SpanStatusCode, context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Runner from "../../src/Runner";
import RunnerNode from "../../src/RunnerNode";

class OkNode extends RunnerNode {
	async run() {
		return { success: true, data: { ok: true }, error: null };
	}
}

class ThrowNode extends RunnerNode {
	async run(): Promise<never> {
		throw new Error("boom");
	}
}

/** Creates a child span inside run() to prove nesting under the step span. */
class ChildSpanNode extends RunnerNode {
	async run() {
		const child = trace.getTracer("child-work").startSpan("child-work");
		child.end();
		return { success: true, data: { ok: true }, error: null };
	}
}

function makeNode<T extends RunnerNode>(N: new () => T, name: string): T {
	const n = new N();
	n.name = name;
	n.node = name;
	n.type = "module";
	n.active = true;
	return n;
}

function makeCtx(overrides: Partial<Context> = {}): Context {
	return {
		id: "test-run",
		workflow_name: "test-wf",
		workflow_path: "/test",
		request: { body: {}, headers: {}, params: {}, query: {} } as unknown as Context["request"],
		response: { data: null, contentType: "application/json", success: true, error: null },
		error: { message: [] },
		logger: { log: () => {}, error: () => {} } as unknown as Context["logger"],
		config: {} as unknown as Context["config"],
		vars: {},
		env: {} as unknown as Context["env"],
		eventLogger: null,
		_PRIVATE_: null,
		...overrides,
	};
}

describe("RunnerSteps — OBS-02 B4 per-step spans", () => {
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

	afterEach(() => exporter.reset());

	const stepSpans = (): ReadableSpan[] => exporter.getFinishedSpans().filter((s) => s.name.startsWith("step "));

	it("emits one child span per executing step with blok.step.* attributes", async () => {
		await new Runner([makeNode(OkNode, "alpha"), makeNode(OkNode, "beta")]).run(makeCtx());

		const spans = stepSpans();
		expect(spans.map((s) => s.name).sort()).toEqual(["step alpha", "step beta"]);

		const alpha = spans.find((s) => s.name === "step alpha");
		expect(alpha?.attributes["blok.step.id"]).toBe("alpha");
		expect(alpha?.attributes["blok.step.index"]).toBe(0);
		expect(alpha?.attributes["blok.node.name"]).toBe("alpha");
		expect(alpha?.attributes["blok.node.type"]).toBe("module");
		expect(alpha?.status.code).toBe(SpanStatusCode.OK);

		const beta = spans.find((s) => s.name === "step beta");
		expect(beta?.attributes["blok.step.index"]).toBe(1);
	});

	it("marks a throwing step's span ERROR with an exception event", async () => {
		await expect(new Runner([makeNode(ThrowNode, "explode")]).run(makeCtx())).rejects.toBeDefined();

		const span = stepSpans().find((s) => s.name === "step explode");
		expect(span).toBeDefined();
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.events.some((e) => e.name === "exception")).toBe(true);
	});

	it("nests a span created inside run() under the step span", async () => {
		await new Runner([makeNode(ChildSpanNode, "gamma")]).run(makeCtx());

		const all = exporter.getFinishedSpans();
		const step = all.find((s) => s.name === "step gamma");
		const child = all.find((s) => s.name === "child-work");
		expect(step).toBeDefined();
		expect(child).toBeDefined();
		// Same trace, child parented under the step span — the exact mechanism
		// that lets a gRPC runtime span (B2.2) nest under its step.
		expect(child?.spanContext().traceId).toBe(step?.spanContext().traceId);
		expect(child?.parentSpanId).toBe(step?.spanContext().spanId);
	});
});
