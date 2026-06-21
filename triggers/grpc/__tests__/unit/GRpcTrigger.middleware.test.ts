/**
 * F1 — GRpcTrigger must apply the middleware chain before running the
 * workflow body. Pre-fix `executeWorkflow` went straight from createContext
 * to `this.run(ctx)` and never called `applyMiddlewareChain`, so a workflow
 * invoked over gRPC executed with NO middleware — including auth gates.
 *
 * This suite uses the REAL `@blokjs/runner` so the inherited
 * `applyMiddlewareChain` seam exists; it spies on the seam + `run()` to
 * assert ordering and short-circuit-on-throw.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const span = {
	setAttribute: vi.fn(),
	setStatus: vi.fn(),
	recordException: vi.fn(),
	end: vi.fn(),
};

vi.mock("@opentelemetry/api", () => ({
	trace: {
		getTracer: () => ({
			startActiveSpan: (_name: string, fn: (s: typeof span) => unknown) => fn(span),
		}),
	},
	metrics: {
		getMeter: () => ({
			createCounter: () => ({ add: vi.fn() }),
			createGauge: () => ({ record: vi.fn() }),
			createHistogram: () => ({ record: vi.fn() }),
			createUpDownCounter: () => ({ add: vi.fn() }),
			createObservableGauge: () => ({ addCallback: vi.fn() }),
			createObservableCounter: () => ({ addCallback: vi.fn() }),
			createObservableUpDownCounter: () => ({ addCallback: vi.fn() }),
		}),
	},
	SpanStatusCode: { OK: 0, ERROR: 1 },
}));

// gRPC constructor builds a fastify http2 server — mock it away.
vi.mock("fastify", () => ({
	default: () => ({ register: vi.fn(), listen: vi.fn(), addresses: () => [] }),
}));

vi.mock("../../src/Nodes", () => ({ default: {} }));
vi.mock("../../src/Workflows", () => ({ default: {} }));

import type { TriggerResponse } from "@blokjs/runner";
import GRpcTrigger from "../../src/GRpcTrigger";
import { MessageEncoding, MessageType, type WorkflowRequest } from "../../src/gen/workflow_pb";

class TestGRpcTrigger extends GRpcTrigger {
	public callOrder: string[] = [];
	public mwThrows = false;

	protected override async applyMiddlewareChain(): Promise<void> {
		this.callOrder.push("applyMiddlewareChain");
		if (this.mwThrows) throw new Error("401 unauthorized");
	}

	override async run(): Promise<TriggerResponse> {
		this.callOrder.push("run");
		return {
			ctx: { response: { data: { ok: true }, contentType: "application/json", success: true, error: null }, id: "x" },
			metrics: { memory: {}, cpu: {} },
		} as any;
	}
}

// A STRING-encoded JSON request carrying a minimal `workflow` (the
// remote-node path is taken whenever the decoded message is defined — it
// reads workflow.steps[0].type, the first trigger key, and nodes.node.inputs).
// `configuration.init` + `run` are stubbed so the build just needs to be
// shaped correctly to reach `applyMiddlewareChain`.
const makeRequest = (): WorkflowRequest =>
	({
		Name: "grpc-wf",
		Encoding: MessageEncoding[MessageEncoding.STRING],
		Type: MessageType[MessageType.JSON],
		Message: JSON.stringify({
			request: { body: { hello: "world" }, query: { requestId: "req-1" } },
			workflow: {
				steps: [{ type: "module" }],
				trigger: { grpc: {} },
				nodes: { node: { inputs: {} } },
			},
		}),
	}) as any;

describe("GRpcTrigger — F1 middleware application", () => {
	let trigger: TestGRpcTrigger;

	beforeEach(() => {
		span.setAttribute.mockClear();
		span.recordException.mockClear();
		trigger = new TestGRpcTrigger();
		// Avoid a real Configuration.init round-trip against a workflow file.
		(trigger as any).configuration = {
			init: vi.fn().mockResolvedValue(undefined),
			name: "grpc-wf",
			version: "1.0.0",
			nodes: {},
		};
	});

	it("calls applyMiddlewareChain BEFORE run()", async () => {
		await trigger.executeWorkflow(makeRequest());
		expect(trigger.callOrder).toEqual(["applyMiddlewareChain", "run"]);
	});

	it("a throwing middleware short-circuits — run() never executes", async () => {
		trigger.mwThrows = true;
		await trigger.executeWorkflow(makeRequest());
		expect(trigger.callOrder).toEqual(["applyMiddlewareChain"]);
		expect(trigger.callOrder).not.toContain("run");
		// The throw is encoded into an error response (outer catch).
		expect(span.recordException).toHaveBeenCalled();
	});
});
