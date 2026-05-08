import type { Context } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import RunnerNode from "../../../../src/RunnerNode";
import {
	NodeRuntimeService,
	bufferToJson,
	decodeExecuteResponse,
	encodeExecuteRequest,
	jsonToBuffer,
} from "../../../../src/adapters/grpc/GrpcCodec";
import type { ExecuteResponseProto } from "../../../../src/adapters/grpc/GrpcCodec";

class TestNode extends RunnerNode {
	async run() {
		return { success: true, data: null, error: null };
	}
}

function makeNode(name = "store-tutorial", type = "runtime.python3"): RunnerNode {
	const n = new TestNode();
	n.name = name;
	n.node = name;
	n.type = type;
	return n;
}

function makeCtx(overrides: Partial<Context> = {}): Context {
	return {
		id: "run_abc123",
		workflow_name: "test-workflow",
		workflow_path: "/test",
		request: {
			body: { hello: "world" },
			headers: { "content-type": "application/json", "x-request-id": "abc" },
			params: { id: "42" },
			query: { foo: "bar" },
			cookies: {},
			method: "POST",
			url: "/test",
			baseUrl: "",
		} as unknown as Context["request"],
		response: { data: { previous: 1 }, contentType: "application/json", success: true, error: null },
		error: { message: [] },
		logger: { log: () => {}, error: () => {} } as unknown as Context["logger"],
		config: {
			"store-tutorial": { inputs: { table: "tutorials", title: "T" } },
		} as unknown as Context["config"],
		vars: { fetch: { id: "v" } },
		env: { NODE_ENV: "test" } as unknown as Context["env"],
		eventLogger: null,
		_PRIVATE_: null,
		...overrides,
	};
}

describe("NodeRuntimeService", () => {
	it("loads from runtime.proto and exposes the service constructor", () => {
		expect(NodeRuntimeService).toBeDefined();
		expect(typeof NodeRuntimeService).toBe("function");
		// proto-loader attaches a `service` descriptor to the constructor.
		const service = (NodeRuntimeService as unknown as { service: Record<string, unknown> }).service;
		expect(service).toBeDefined();
		expect(service).toHaveProperty("Execute");
		expect(service).toHaveProperty("ExecuteStream");
		expect(service).toHaveProperty("Health");
		expect(service).toHaveProperty("ListNodes");
	});
});

describe("jsonToBuffer / bufferToJson round-trip", () => {
	it("preserves objects, arrays, primitives", () => {
		const samples: unknown[] = [{ a: 1, b: "two", c: [3, 4, 5] }, [1, 2, 3], "plain string", 42, true, null];
		for (const s of samples) {
			const buf = jsonToBuffer(s);
			const decoded = bufferToJson(buf);
			expect(decoded).toEqual(s);
		}
	});

	it("encodes null/undefined as empty buffer; decodes empty buffer as null", () => {
		expect(jsonToBuffer(null).length).toBe(0);
		expect(jsonToBuffer(undefined).length).toBe(0);
		expect(bufferToJson(Buffer.alloc(0))).toBeNull();
		expect(bufferToJson(undefined)).toBeNull();
	});

	it("decodes malformed JSON as the raw string (best effort)", () => {
		const buf = Buffer.from("not json", "utf-8");
		expect(bufferToJson(buf)).toBe("not json");
	});
});

describe("encodeExecuteRequest", () => {
	it("populates NodeRef from the runner node fields", () => {
		const req = encodeExecuteRequest(makeNode(), makeCtx(), 0, 1, 0, 30_000);
		expect(req.node.name).toBe("store-tutorial");
		expect(req.node.type).toBe("runtime.python3");
	});

	it("sends resolved inputs UNWRAPPED (no {inputs:{...}} envelope)", () => {
		const req = encodeExecuteRequest(makeNode(), makeCtx(), 0, 1, 0, 30_000);
		const decoded = bufferToJson(req.inputs);
		expect(decoded).toEqual({ table: "tutorials", title: "T" });
	});

	it("falls back to ctx.response.data when no resolved inputs exist", () => {
		const ctx = makeCtx({ config: {} as unknown as Context["config"] });
		const req = encodeExecuteRequest(makeNode(), ctx, 0, 1, 0, 30_000);
		const decoded = bufferToJson(req.inputs);
		expect(decoded).toEqual({ previous: 1 });
	});

	it("populates StepInfo from the call arguments", () => {
		const req = encodeExecuteRequest(makeNode(), makeCtx(), 3, 7, 1, 30_000);
		expect(req.step.name).toBe("store-tutorial");
		expect(req.step.index).toBe(3);
		expect(req.step.total).toBe(7);
		expect(req.step.depth).toBe(1);
	});

	it("populates state.previous_output from ctx.response.data", () => {
		const req = encodeExecuteRequest(makeNode(), makeCtx(), 0, 1, 0, 30_000);
		expect(bufferToJson(req.state.previousOutput)).toEqual({ previous: 1 });
	});

	it("populates state.vars from ctx.vars", () => {
		const req = encodeExecuteRequest(makeNode(), makeCtx(), 0, 1, 0, 30_000);
		expect(bufferToJson(req.state.vars)).toEqual({ fetch: { id: "v" } });
	});

	it("filters non-string env entries out of state.env", () => {
		const ctx = makeCtx({
			env: { GOOD: "yes", BAD: undefined, ALSO_GOOD: "x" } as unknown as Context["env"],
		});
		const req = encodeExecuteRequest(makeNode(), ctx, 0, 1, 0, 30_000);
		expect(req.state.env).toEqual({ GOOD: "yes", ALSO_GOOD: "x" });
	});

	it("encodes the request body as JSON bytes for object bodies", () => {
		const req = encodeExecuteRequest(makeNode(), makeCtx(), 0, 1, 0, 30_000);
		expect(bufferToJson(req.trigger.body)).toEqual({ hello: "world" });
	});

	it("preserves a string body as UTF-8 bytes", () => {
		const ctx = makeCtx();
		(ctx.request as unknown as { body: unknown }).body = "raw text";
		const req = encodeExecuteRequest(makeNode(), ctx, 0, 1, 0, 30_000);
		expect(req.trigger.body.toString("utf-8")).toBe("raw text");
	});

	it("populates trigger headers/params/query as string maps", () => {
		const req = encodeExecuteRequest(makeNode(), makeCtx(), 0, 1, 0, 30_000);
		expect(req.trigger.headers["content-type"]).toBe("application/json");
		expect(req.trigger.params.id).toBe("42");
		expect(req.trigger.query.foo).toBe("bar");
	});

	it("populates workflow info from ctx", () => {
		const req = encodeExecuteRequest(makeNode(), makeCtx(), 0, 1, 0, 30_000);
		expect(req.workflow.runId).toBe("run_abc123");
		expect(req.workflow.name).toBe("test-workflow");
		expect(req.workflow.path).toBe("/test");
	});

	it("populates options.deadlineMs as a string (proto int64)", () => {
		const req = encodeExecuteRequest(makeNode(), makeCtx(), 0, 1, 0, 45_000);
		expect(req.options.deadlineMs).toBe("45000");
		expect(req.options.captureMetrics).toBe(true);
	});

	it("survives missing ctx.request gracefully", () => {
		const ctx = makeCtx({ request: undefined as unknown as Context["request"] });
		expect(() => encodeExecuteRequest(makeNode(), ctx, 0, 1, 0, 30_000)).not.toThrow();
	});

	it("survives missing ctx.vars gracefully", () => {
		const ctx = makeCtx({ vars: undefined });
		const req = encodeExecuteRequest(makeNode(), ctx, 0, 1, 0, 30_000);
		expect(bufferToJson(req.state.vars)).toEqual({});
	});
});

describe("decodeExecuteResponse", () => {
	it("decodes a successful response with all fields", () => {
		const proto: ExecuteResponseProto = {
			success: true,
			data: jsonToBuffer({ user: { id: "abc" } }),
			contentType: "application/json",
			error: null,
			varsDelta: jsonToBuffer({ cached: true }),
			logs: [
				{
					timestamp: { seconds: "1700000000", nanos: 500_000_000 },
					level: "info",
					message: "ok",
					attributes: { trace: "x" },
				},
			],
			metrics: {
				durationMs: 12.5,
				cpuMs: 4.2,
				memoryBytes: "1048576",
				requestBytes: "256",
				responseBytes: "128",
			},
		};

		const decoded = decodeExecuteResponse(proto);
		expect(decoded.success).toBe(true);
		expect(decoded.data).toEqual({ user: { id: "abc" } });
		expect(decoded.contentType).toBe("application/json");
		expect(decoded.varsDelta).toEqual({ cached: true });
		expect(decoded.logs).toHaveLength(1);
		expect(decoded.logs[0].timestamp).toBe(1700000000500);
		expect(decoded.logs[0].level).toBe("info");
		expect(decoded.metrics.durationMs).toBe(12.5);
		expect(decoded.metrics.memoryBytes).toBe(1048576);
	});

	it("decodes an error response with structured fields and cause chain", () => {
		const proto: ExecuteResponseProto = {
			success: false,
			data: Buffer.alloc(0),
			contentType: "application/json",
			varsDelta: Buffer.alloc(0),
			logs: [],
			metrics: null,
			error: {
				code: "POSTGRES_CONNECT_TIMEOUT",
				category: "DEPENDENCY",
				severity: "ERROR",
				node: "store-tutorial",
				sdk: "blok-python3",
				sdkVersion: "1.0.0",
				runtimeKind: "runtime.python3",
				at: { seconds: "1700000000", nanos: 0 },
				message: "Could not connect within 5s",
				description: "host=db port=5432 timeout=5000ms",
				remediation: "Check DATABASE_URL",
				docUrl: "",
				causes: [
					{
						code: "DNS_TIMEOUT",
						category: "TIMEOUT",
						severity: "ERROR",
						node: "",
						sdk: "",
						sdkVersion: "",
						runtimeKind: "",
						at: null,
						message: "dns timeout",
						description: "",
						remediation: "",
						docUrl: "",
						causes: [],
						stack: "",
						contextSnapshotJson: Buffer.alloc(0),
						httpStatus: 504,
						retryable: true,
						retryAfterMs: "0",
						detailsJson: Buffer.alloc(0),
					},
				],
				stack: "Traceback...",
				contextSnapshotJson: jsonToBuffer({ host: "db" }),
				httpStatus: 502,
				retryable: true,
				retryAfterMs: "5000",
				detailsJson: jsonToBuffer({ sqlState: "08001" }),
			},
		};

		const decoded = decodeExecuteResponse(proto);
		expect(decoded.success).toBe(false);
		expect(decoded.error).not.toBeNull();
		expect(decoded.error?.code).toBe("POSTGRES_CONNECT_TIMEOUT");
		expect(decoded.error?.category).toBe("DEPENDENCY");
		expect(decoded.error?.httpStatus).toBe(502);
		expect(decoded.error?.retryAfterMs).toBe(5000);
		expect(decoded.error?.contextSnapshot).toEqual({ host: "db" });
		expect(decoded.error?.details).toEqual({ sqlState: "08001" });
		expect(decoded.error?.causes).toHaveLength(1);
		expect(decoded.error?.causes[0].code).toBe("DNS_TIMEOUT");
	});

	it("defaults missing optional fields", () => {
		const proto: ExecuteResponseProto = {
			success: true,
			data: Buffer.alloc(0),
			contentType: "",
			error: null,
			varsDelta: Buffer.alloc(0),
			logs: [],
			metrics: null,
		};
		const decoded = decodeExecuteResponse(proto);
		expect(decoded.contentType).toBe("application/json");
		expect(decoded.data).toBeNull();
		expect(decoded.varsDelta).toEqual({});
		expect(decoded.metrics.durationMs).toBe(0);
	});
});
