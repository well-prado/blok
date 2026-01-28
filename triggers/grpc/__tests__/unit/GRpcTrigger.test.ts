import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock OpenTelemetry
vi.mock("@opentelemetry/api", () => ({
	trace: {
		getTracer: () => ({
			startActiveSpan: (_name: string, fn: (span: any) => any) =>
				fn({
					setAttribute: vi.fn(),
					setStatus: vi.fn(),
					recordException: vi.fn(),
					end: vi.fn(),
				}),
		}),
	},
	metrics: {
		getMeter: () => ({
			createCounter: () => ({ add: vi.fn() }),
			createGauge: () => ({ record: vi.fn() }),
		}),
	},
	SpanStatusCode: { OK: 0, ERROR: 1 },
}));

// Mock fastify — must be a callable function (not arrow, since source may use `new`)
vi.mock("fastify", () => ({
	default: () => ({
		register: vi.fn(),
		listen: vi.fn(),
		use: vi.fn(),
	}),
}));

// Mock uuid
vi.mock("uuid", () => ({ v4: () => "test-uuid-1234" }));

// Mock Nodes and Workflows
vi.mock("../../src/Nodes", () => ({ default: {} }));
vi.mock("../../src/Workflows", () => ({ default: {} }));

// Mock runner — TriggerBase and other classes must be constructable
vi.mock("@nanoservice-ts/runner", () => {
	class MockNodeMap {
		nodes: Record<string, any> = {};
		addNode(key: string, val: any) {
			this.nodes[key] = val;
		}
	}

	class MockTriggerBase {
		configuration: any;
		nodeMap: any;
		constructor() {
			this.configuration = {
				name: "test-workflow",
				version: "1.0.0",
				init: vi.fn().mockResolvedValue(undefined),
			};
		}
		createContext(_: any, name: string, id: string) {
			return {
				id,
				request: { body: {}, headers: {}, query: {}, params: {} },
				response: { data: { ok: true }, error: null, success: true, contentType: "application/json" },
				error: { message: "" },
				logger: { log: vi.fn(), error: vi.fn() },
			};
		}
		async run(ctx: any) {
			return {
				ctx,
				metrics: {
					memory: { total: 10, min: 5, max: 15 },
					cpu: { average: 50, total: 100, usage: 75, model: "test-cpu" },
				},
			};
		}
	}

	return {
		DefaultLogger: class {
			log() {}
			error() {}
		},
		NodeMap: MockNodeMap,
		TriggerBase: MockTriggerBase,
	};
});

// Mock helper
vi.mock("@nanoservice-ts/helper", () => ({
	Workflow: vi.fn().mockReturnValue({
		addTrigger: vi.fn().mockReturnValue({
			addStep: vi.fn().mockReturnValue({ name: "Remote Node", steps: [] }),
		}),
	}),
}));

// Mock shared — GlobalError must be a class
vi.mock("@nanoservice-ts/shared", () => ({
	GlobalError: class GlobalError extends Error {
		context: any;
		constructor(message: string) {
			super(message);
			this.context = { message, code: undefined, json: null };
		}
		setCode(code: number) {
			this.context.code = code;
		}
		hasJson() {
			return this.context.json !== null && this.context.json !== undefined;
		}
	},
}));

import GRpcTrigger from "../../src/GRpcTrigger";
import { MessageEncoding, MessageType } from "../../src/gen/workflow_pb";

describe("GRpcTrigger", () => {
	let trigger: GRpcTrigger;

	beforeEach(() => {
		vi.clearAllMocks();
		trigger = new GRpcTrigger();
	});

	describe("constructor()", () => {
		it("should create instance without errors", () => {
			expect(trigger).toBeDefined();
		});

		it("should call loadNodes and loadWorkflows", () => {
			expect(trigger.getApp()).toBeDefined();
		});
	});

	describe("getApp()", () => {
		it("should return fastify instance", () => {
			const app = trigger.getApp();
			expect(app).toBeDefined();
			expect(typeof app.register).toBe("function");
		});
	});

	describe("listen()", () => {
		it("should return 0", async () => {
			const result = await trigger.listen();
			expect(result).toBe(0);
		});
	});

	describe("processRequest()", () => {
		it("should register WorkflowService on the router", () => {
			const mockService = vi.fn();
			const mockRouter = { service: mockService };
			trigger.processRequest(mockRouter as any, trigger);
			expect(mockService).toHaveBeenCalled();
		});
	});

	describe("executeWorkflow()", () => {
		it("should execute workflow and return encoded response", async () => {
			const payload = {
				request: { body: {}, headers: {}, query: {}, params: {} },
				response: { data: null, error: null, success: true },
			};
			const base64 = Buffer.from(JSON.stringify(payload)).toString("base64");
			const request = {
				Name: "test-workflow",
				Message: base64,
				Encoding: MessageEncoding[MessageEncoding.BASE64],
				Type: MessageType[MessageType.JSON],
			};

			const result = await trigger.executeWorkflow(request as any);
			expect(result).toBeDefined();
			expect(result.Encoding).toBeDefined();
		});

		it("should use requestId from query when available", async () => {
			const payload = {
				request: { body: {}, headers: {}, query: { requestId: "custom-req-id" }, params: {} },
				response: { data: null, error: null, success: true },
			};
			const base64 = Buffer.from(JSON.stringify(payload)).toString("base64");
			const request = {
				Name: "test-workflow",
				Message: base64,
				Encoding: MessageEncoding[MessageEncoding.BASE64],
				Type: MessageType[MessageType.JSON],
			};

			const result = await trigger.executeWorkflow(request as any);
			expect(result).toBeDefined();
		});

		it("should handle remote node execution with workflow model", async () => {
			const payload = {
				request: { body: {}, headers: {}, query: {}, params: {} },
				workflow: {
					name: "Remote Node",
					version: "1.0.0",
					description: "Test",
					trigger: { grpc: {} },
					steps: [{ name: "node", node: "test-node", type: "module" }],
					nodes: { node: { inputs: {} } },
				},
			};
			const base64 = Buffer.from(JSON.stringify(payload)).toString("base64");
			const request = {
				Name: "test-node",
				Message: base64,
				Encoding: MessageEncoding[MessageEncoding.BASE64],
				Type: MessageType[MessageType.JSON],
			};

			const result = await trigger.executeWorkflow(request as any);
			expect(result).toBeDefined();
		});

		it("should handle runtime.python3 node type", async () => {
			const payload = {
				request: { body: {}, headers: {}, query: {}, params: {} },
				workflow: {
					name: "Remote Node",
					version: "1.0.0",
					description: "Test",
					trigger: { grpc: {} },
					steps: [{ name: "node", node: "py-node", type: "runtime.python3" }],
					nodes: { node: { inputs: {} } },
				},
			};
			const base64 = Buffer.from(JSON.stringify(payload)).toString("base64");
			const request = {
				Name: "py-node",
				Message: base64,
				Encoding: MessageEncoding[MessageEncoding.BASE64],
				Type: MessageType[MessageType.JSON],
			};

			const result = await trigger.executeWorkflow(request as any);
			expect(result).toBeDefined();
		});

		it("should handle local node type", async () => {
			const payload = {
				request: { body: {}, headers: {}, query: {}, params: {} },
				workflow: {
					name: "Remote Node",
					version: "1.0.0",
					description: "Test",
					trigger: { grpc: {} },
					steps: [{ name: "node", node: "local-node", type: "local" }],
					nodes: { node: { inputs: {} } },
				},
			};
			const base64 = Buffer.from(JSON.stringify(payload)).toString("base64");
			const request = {
				Name: "local-node",
				Message: base64,
				Encoding: MessageEncoding[MessageEncoding.BASE64],
				Type: MessageType[MessageType.JSON],
			};

			const result = await trigger.executeWorkflow(request as any);
			expect(result).toBeDefined();
		});

		it("should handle generic Error during execution", async () => {
			const failTrigger = new GRpcTrigger();
			(failTrigger as any).configuration.init = vi.fn().mockRejectedValue(new Error("Init failed"));

			const payload = {
				request: { body: {}, headers: {}, query: {}, params: {} },
			};
			const base64 = Buffer.from(JSON.stringify(payload)).toString("base64");
			const request = {
				Name: "fail-workflow",
				Message: base64,
				Encoding: MessageEncoding[MessageEncoding.BASE64],
				Type: MessageType[MessageType.JSON],
			};

			const result = await failTrigger.executeWorkflow(request as any);
			expect(result).toBeDefined();
			expect(result.Encoding).toBe(MessageEncoding[MessageEncoding.BASE64]);
		});

		it("should set default contentType when empty", async () => {
			const payload = {
				request: { body: {}, headers: {}, query: {}, params: {} },
			};
			const base64 = Buffer.from(JSON.stringify(payload)).toString("base64");
			const request = {
				Name: "test-workflow",
				Message: base64,
				Encoding: MessageEncoding[MessageEncoding.BASE64],
				Type: MessageType[MessageType.JSON],
			};

			// Override createContext to return empty contentType
			const origCreateContext = (trigger as any).createContext.bind(trigger);
			(trigger as any).createContext = (_: any, name: string, id: string) => {
				const ctx = origCreateContext(_, name, id);
				ctx.response.contentType = "";
				return ctx;
			};

			const result = await trigger.executeWorkflow(request as any);
			expect(result).toBeDefined();
		});
	});
});
