import { BlokError, type Context, ErrorCategory, type NodeErrorPayload } from "@blokjs/shared";
import {
	status as GrpcStatus,
	Metadata,
	type Server,
	type ServerCredentials,
	ServerCredentials as ServerCredentialsCtor,
	Server as ServerCtor,
	type ServiceError,
} from "@grpc/grpc-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import RunnerNode from "../../../../src/RunnerNode";
import {
	type DecodedExecuteEvent,
	type ExecuteEventProto,
	type ExecuteRequestProto,
	type ExecuteResponseProto,
	NodeRuntimeService,
	bufferToJson,
	jsonToBuffer,
} from "../../../../src/adapters/grpc/GrpcCodec";
import { GrpcRuntimeAdapter } from "../../../../src/adapters/grpc/GrpcRuntimeAdapter";
import { GRPC_DEFAULTS, type GrpcAdapterConfig } from "../../../../src/adapters/grpc/types";

class TestNode extends RunnerNode {
	async run() {
		return { success: true, data: null, error: null };
	}
}

function makeNode(name = "echo", type = "runtime.python3"): RunnerNode {
	const n = new TestNode();
	n.name = name;
	n.node = name;
	n.type = type;
	return n;
}

function makeCtx(overrides: Partial<Context> = {}): Context {
	return {
		id: "run_xyz",
		workflow_name: "wf",
		workflow_path: "/wf",
		request: {
			body: { hello: "world" },
			headers: {},
			params: {},
			query: {},
			cookies: {},
			method: "POST",
			url: "/wf",
			baseUrl: "",
		} as unknown as Context["request"],
		response: { data: null, contentType: "application/json", success: true, error: null },
		error: { message: [] },
		logger: { log: () => {}, error: () => {} } as unknown as Context["logger"],
		config: {
			echo: { inputs: { msg: "ping" } },
		} as unknown as Context["config"],
		vars: {},
		env: {} as unknown as Context["env"],
		eventLogger: null,
		_PRIVATE_: null,
		...overrides,
	};
}

/** Behavior options for the mock NodeRuntime server. */
interface MockServerBehavior {
	executeImpl?: (request: ExecuteRequestProto) => ExecuteResponseProto | Error;
	healthImpl?: () => "SERVING" | "NOT_SERVING" | "UNKNOWN" | Error;
	/**
	 * Server-streaming `ExecuteStream` impl. Each yielded `ExecuteEventProto`
	 * is written to the call. If a value of type `Error` is yielded the
	 * server destroys the call with that error; if `null` is yielded the
	 * call ends silently. Defaults to ending immediately (no events).
	 */
	executeStreamImpl?: (request: ExecuteRequestProto) => Iterable<ExecuteEventProto | Error | null>;
}

/** Spin up a real gRPC server on a random port for integration testing. */
async function startMockServer(behavior: MockServerBehavior): Promise<{
	server: Server;
	port: number;
	stop: () => Promise<void>;
}> {
	const server: Server = new ServerCtor();

	server.addService((NodeRuntimeService as unknown as { service: Parameters<typeof server.addService>[0] }).service, {
		Execute: (
			call: { request: ExecuteRequestProto; metadata: Metadata },
			callback: (err: ServiceError | null, response?: ExecuteResponseProto) => void,
		) => {
			const result = behavior.executeImpl?.(call.request);
			if (result instanceof Error) {
				callback(result as ServiceError);
			} else if (result) {
				callback(null, result);
			} else {
				// Default: echo the inputs back as data.
				callback(null, {
					success: true,
					data: call.request.inputs,
					contentType: "application/json",
					error: null,
					varsDelta: Buffer.alloc(0),
					logs: [],
					metrics: {
						durationMs: 1.5,
						cpuMs: 0.5,
						memoryBytes: "1024",
						requestBytes: "0",
						responseBytes: "0",
					},
				});
			}
		},
		Health: (
			_call: unknown,
			callback: (
				err: ServiceError | null,
				response?: { status: string; sdkVersion: string; registeredNodes: string[] },
			) => void,
		) => {
			const result = behavior.healthImpl?.() ?? "SERVING";
			if (result instanceof Error) {
				callback(result as ServiceError);
			} else {
				callback(null, { status: result, sdkVersion: "1.0.0", registeredNodes: [] });
			}
		},
		ListNodes: (_call: unknown, callback: (err: ServiceError | null, response?: unknown) => void) => {
			callback(null, { nodes: [], sdkName: "blok-test", sdkVersion: "1.0.0", protoVersion: "1.0.0" });
		},
		ExecuteStream: (call: {
			request: ExecuteRequestProto;
			write: (event: ExecuteEventProto) => void;
			end: () => void;
			emit: (event: "error", err: ServiceError) => void;
		}) => {
			const events = behavior.executeStreamImpl?.(call.request);
			if (!events) {
				call.end();
				return;
			}
			for (const ev of events) {
				if (ev === null) {
					call.end();
					return;
				}
				if (ev instanceof Error) {
					call.emit("error", ev as ServiceError);
					return;
				}
				call.write(ev);
			}
			call.end();
		},
	});

	const creds: ServerCredentials = ServerCredentialsCtor.createInsecure();
	const port = await new Promise<number>((resolve, reject) => {
		server.bindAsync("127.0.0.1:0", creds, (err, p) => {
			if (err) reject(err);
			else resolve(p);
		});
	});

	return {
		server,
		port,
		stop: () =>
			new Promise<void>((resolve) => {
				server.tryShutdown(() => resolve());
			}),
	};
}

function makeAdapterConfig(port: number, overrides: Partial<GrpcAdapterConfig> = {}): GrpcAdapterConfig {
	return {
		kind: "python3",
		host: "127.0.0.1",
		port,
		defaultDeadlineMs: 5_000,
		maxMessageBytes: GRPC_DEFAULTS.MAX_MESSAGE_BYTES,
		keepalive: {
			timeMs: GRPC_DEFAULTS.KEEPALIVE_TIME_MS,
			timeoutMs: GRPC_DEFAULTS.KEEPALIVE_TIMEOUT_MS,
			permitWithoutCalls: GRPC_DEFAULTS.KEEPALIVE_PERMIT_WITHOUT_CALLS,
		},
		// Disable the background health probe loop in unit tests by default —
		// individual tests opt in by passing a positive interval.
		healthCheckIntervalMs: 0,
		...overrides,
	};
}

describe("GrpcRuntimeAdapter (integration with mock server)", () => {
	let mock: Awaited<ReturnType<typeof startMockServer>>;
	let adapter: GrpcRuntimeAdapter;
	let lastRequest: ExecuteRequestProto | null = null;
	let executeOverride: ((req: ExecuteRequestProto) => ExecuteResponseProto | Error) | null = null;
	let healthOverride: (() => "SERVING" | "NOT_SERVING" | "UNKNOWN" | Error) | null = null;
	let executeStreamOverride: ((req: ExecuteRequestProto) => Iterable<ExecuteEventProto | Error | null>) | null = null;

	beforeAll(async () => {
		mock = await startMockServer({
			executeImpl: (req) => {
				lastRequest = req;
				if (executeOverride) return executeOverride(req);
				return {
					success: true,
					data: req.inputs,
					contentType: "application/json",
					error: null,
					varsDelta: Buffer.alloc(0),
					logs: [],
					metrics: {
						durationMs: 1.5,
						cpuMs: 0.5,
						memoryBytes: "1024",
						requestBytes: "0",
						responseBytes: "0",
					},
				};
			},
			healthImpl: () => healthOverride?.() ?? "SERVING",
			executeStreamImpl: (req) => {
				lastRequest = req;
				return executeStreamOverride?.(req) ?? [];
			},
		});
		adapter = new GrpcRuntimeAdapter(makeAdapterConfig(mock.port));
	});

	beforeEach(() => {
		lastRequest = null;
		executeOverride = null;
		healthOverride = null;
		executeStreamOverride = null;
	});

	afterAll(async () => {
		adapter.close();
		await mock.stop();
	});

	describe("execute()", () => {
		it("returns success=true and the decoded data", async () => {
			const result = await adapter.execute(makeNode(), makeCtx());
			expect(result.success).toBe(true);
			expect(result.data).toEqual({ msg: "ping" });
			expect(result.errors).toBeNull();
			expect(result.metrics?.duration_ms).toBeGreaterThan(0);
		});

		it("sends inputs UNWRAPPED on the wire (Fix #3 closed)", async () => {
			await adapter.execute(makeNode(), makeCtx());
			expect(lastRequest).not.toBeNull();
			const inputs = bufferToJson(lastRequest!.inputs);
			expect(inputs).toEqual({ msg: "ping" });
		});

		it("populates StepInfo from ctx._stepInfo when set", async () => {
			const ctx = makeCtx();
			(ctx as Record<string, unknown>)._stepInfo = { index: 2, total: 5, depth: 1 };
			await adapter.execute(makeNode(), ctx);
			expect(lastRequest!.step.index).toBe(2);
			expect(lastRequest!.step.total).toBe(5);
			expect(lastRequest!.step.depth).toBe(1);
		});

		it("defaults StepInfo to (0, 1, 0) when ctx._stepInfo is absent", async () => {
			await adapter.execute(makeNode(), makeCtx());
			expect(lastRequest!.step.index).toBe(0);
			expect(lastRequest!.step.total).toBe(1);
			expect(lastRequest!.step.depth).toBe(0);
		});

		it("respects per-call deadline from ctx._stepDeadlineMs", async () => {
			const ctx = makeCtx();
			(ctx as Record<string, unknown>)._stepDeadlineMs = 12_345;
			await adapter.execute(makeNode(), ctx);
			expect(lastRequest!.options.deadlineMs).toBe("12345");
		});

		it("decodes a structured NodeError payload from a success=false response", async () => {
			const errPayload: NodeErrorPayload = {
				code: "DB_DOWN",
				category: ErrorCategory.DEPENDENCY,
				severity: "ERROR",
				node: "echo",
				sdk: "blok-python3",
				sdkVersion: "1.0.0",
				runtimeKind: "runtime.python3",
				at: new Date().toISOString(),
				message: "Postgres unreachable",
				description: "host=db port=5432",
				remediation: "Check DATABASE_URL",
				docUrl: "",
				causes: [],
				stack: "Traceback (most recent call last)…",
				contextSnapshot: { host: "db" },
				httpStatus: 502,
				retryable: true,
				retryAfterMs: 5000,
				details: { sqlState: "08001" },
			};
			executeOverride = () => ({
				success: false,
				data: Buffer.alloc(0),
				contentType: "application/json",
				error: {
					code: errPayload.code,
					category: errPayload.category,
					severity: errPayload.severity,
					node: errPayload.node,
					sdk: errPayload.sdk,
					sdkVersion: errPayload.sdkVersion,
					runtimeKind: errPayload.runtimeKind,
					at: { seconds: String(Math.floor(Date.now() / 1000)), nanos: 0 },
					message: errPayload.message,
					description: errPayload.description,
					remediation: errPayload.remediation,
					docUrl: errPayload.docUrl,
					causes: [],
					stack: errPayload.stack,
					contextSnapshotJson: jsonToBuffer(errPayload.contextSnapshot),
					httpStatus: errPayload.httpStatus,
					retryable: errPayload.retryable,
					retryAfterMs: String(errPayload.retryAfterMs),
					detailsJson: jsonToBuffer(errPayload.details),
				},
				varsDelta: Buffer.alloc(0),
				logs: [],
				metrics: null,
			});

			const result = await adapter.execute(makeNode(), makeCtx());
			expect(result.success).toBe(false);
			expect(result.errors).toBeInstanceOf(BlokError);
			const err = result.errors as BlokError;
			expect(err.errorCode).toBe("DB_DOWN");
			expect(err.category).toBe(ErrorCategory.DEPENDENCY);
			expect(err.description).toContain("port=5432");
			expect(err.remediation).toBe("Check DATABASE_URL");
			expect(err.retryable).toBe(true);
			expect(err.retryAfterMs).toBe(5000);
			expect(err.details).toEqual({ sqlState: "08001" });
		});

		it("converts a gRPC ServiceError thrown by the server into a BlokError", async () => {
			executeOverride = () =>
				Object.assign(new Error("invalid"), {
					code: GrpcStatus.INVALID_ARGUMENT,
					details: "missing field 'msg'",
					metadata: new Metadata(),
				}) as unknown as Error;

			const result = await adapter.execute(makeNode(), makeCtx());
			expect(result.success).toBe(false);
			expect(result.errors).toBeInstanceOf(BlokError);
			const err = result.errors as BlokError;
			expect(err.category).toBe(ErrorCategory.VALIDATION);
			expect(err.errorCode).toBe("GRPC_INVALID_ARGUMENT");
			expect(err.message).toBe("missing field 'msg'");
		});

		it("forwards SDK-supplied vars_delta to ExecutionResult.vars", async () => {
			executeOverride = (req) => ({
				success: true,
				data: req.inputs,
				contentType: "application/json",
				error: null,
				varsDelta: jsonToBuffer({ stored: "yes" }),
				logs: [],
				metrics: null,
			});
			const result = await adapter.execute(makeNode(), makeCtx());
			expect(result.vars).toEqual({ stored: "yes" });
		});

		it("forwards SDK-supplied logs to ExecutionResult.logs", async () => {
			executeOverride = (req) => ({
				success: true,
				data: req.inputs,
				contentType: "application/json",
				error: null,
				varsDelta: Buffer.alloc(0),
				logs: [
					{ timestamp: null, level: "info", message: "started", attributes: {} },
					{ timestamp: null, level: "warn", message: "slow query", attributes: {} },
				],
				metrics: null,
			});
			const result = await adapter.execute(makeNode(), makeCtx());
			expect(result.logs).toEqual(["[info] started", "[warn] slow query"]);
		});
	});

	describe("executeStream()", () => {
		const finalSuccessFrame = (data: unknown): ExecuteEventProto => ({
			event: "final",
			final: {
				success: true,
				data: jsonToBuffer(data),
				contentType: "application/json",
				error: null,
				varsDelta: Buffer.alloc(0),
				logs: [],
				metrics: null,
			},
		});

		it("emits decoded events in order and resolves the typed result", async () => {
			executeStreamOverride = () => [
				{ event: "started", started: { at: { seconds: "1700000000", nanos: 0 } } },
				{
					event: "log",
					log: { timestamp: null, level: "info", message: "hi", attributes: { src: "test" } },
				},
				{ event: "progress", progress: { percent: 0.5, phase: "halfway" } },
				finalSuccessFrame({ ok: true }),
			];

			const { events, result } = adapter.executeStream(makeNode(), makeCtx());
			const collected: DecodedExecuteEvent[] = [];
			for await (const ev of events) collected.push(ev);
			const final = await result;

			expect(collected.map((e) => e.type)).toEqual(["started", "log", "progress", "final"]);
			const log = collected[1];
			expect(log.type).toBe("log");
			if (log.type === "log") {
				expect(log.log.message).toBe("hi");
				expect(log.log.attributes).toEqual({ src: "test" });
			}
			const progress = collected[2];
			expect(progress.type).toBe("progress");
			if (progress.type === "progress") {
				expect(progress.percent).toBe(0.5);
				expect(progress.phase).toBe("halfway");
			}

			expect(final.success).toBe(true);
			expect(final.data).toEqual({ ok: true });
			expect(final.errors).toBeNull();
		});

		it("opts the SDK into log streaming via ExecuteOptions.streamLogs=true", async () => {
			executeStreamOverride = () => [finalSuccessFrame({ ack: 1 })];
			const { events, result } = adapter.executeStream(makeNode(), makeCtx());
			for await (const _ of events) {
				/* drain */
			}
			await result;
			expect(lastRequest?.options.streamLogs).toBe(true);
		});

		it("yields nothing and resolves to a BlokError when the stream ends without a final frame", async () => {
			executeStreamOverride = () => [{ event: "started", started: { at: { seconds: "1700000000", nanos: 0 } } }];

			const { events, result } = adapter.executeStream(makeNode(), makeCtx());
			const collected: DecodedExecuteEvent[] = [];
			for await (const ev of events) collected.push(ev);
			const final = await result;

			expect(collected.map((e) => e.type)).toEqual(["started"]);
			expect(final.success).toBe(false);
			expect(final.errors).toBeInstanceOf(BlokError);
			expect((final.errors as BlokError).message).toMatch(/final frame/i);
		});

		it("maps server-side stream errors to a BlokError on the result promise", async () => {
			executeStreamOverride = () => [
				Object.assign(new Error("boom"), {
					code: GrpcStatus.INTERNAL,
					details: "internal failure",
					metadata: new Metadata(),
				}),
			];

			const { events, result } = adapter.executeStream(makeNode(), makeCtx());
			const collected: DecodedExecuteEvent[] = [];
			for await (const ev of events) collected.push(ev);
			const final = await result;

			expect(final.success).toBe(false);
			expect(final.errors).toBeInstanceOf(BlokError);
			expect((final.errors as BlokError).errorCode).toBe("GRPC_INTERNAL");
		});

		it("decodes a partial-result frame", async () => {
			executeStreamOverride = () => [
				{ event: "partial", partial: { snapshotJson: jsonToBuffer({ progress: "checkpoint-1" }) } },
				finalSuccessFrame({ done: true }),
			];

			const { events, result } = adapter.executeStream(makeNode(), makeCtx());
			const collected: DecodedExecuteEvent[] = [];
			for await (const ev of events) collected.push(ev);
			await result;

			const partial = collected[0];
			expect(partial.type).toBe("partial");
			if (partial.type === "partial") {
				expect(partial.snapshot).toEqual({ progress: "checkpoint-1" });
			}
		});
	});

	describe("checkHealth()", () => {
		it("returns true when the SDK reports SERVING", async () => {
			expect(await adapter.checkHealth()).toBe(true);
		});

		it("returns false when the SDK reports NOT_SERVING", async () => {
			healthOverride = () => "NOT_SERVING";
			expect(await adapter.checkHealth()).toBe(false);
		});

		it("returns false when the SDK errors", async () => {
			healthOverride = () =>
				Object.assign(new Error("server down"), {
					code: GrpcStatus.UNAVAILABLE,
					details: "down",
					metadata: new Metadata(),
				}) as unknown as Error;
			expect(await adapter.checkHealth()).toBe(false);
		});
	});

	describe("misconfigured adapter", () => {
		it("execute() returns a DEPENDENCY error when the host is unreachable", async () => {
			const isolated = new GrpcRuntimeAdapter(makeAdapterConfig(1, { defaultDeadlineMs: 500 }));
			try {
				const result = await isolated.execute(makeNode(), makeCtx());
				expect(result.success).toBe(false);
				expect(result.errors).toBeInstanceOf(BlokError);
				const err = result.errors as BlokError;
				expect([ErrorCategory.DEPENDENCY, ErrorCategory.TIMEOUT]).toContain(err.category);
			} finally {
				isolated.close();
			}
		});
	});

	describe("circuit breaker (health-check integration)", () => {
		// Tests that opt the adapter INTO the background health loop. Each
		// test owns its adapter instance + cleans up on teardown.

		it("execute() short-circuits with GRPC_RUNTIME_UNAVAILABLE once the breaker is open", async () => {
			// Start an isolated adapter pointed at a port we can take down.
			const isolated = new GrpcRuntimeAdapter(
				makeAdapterConfig(mock.port, {
					healthCheckIntervalMs: 1, // arbitrarily fast for the test
					healthCheckFailureThreshold: 2,
				}),
			);
			try {
				// Force health to fail twice via the mock so the breaker opens.
				healthOverride = () => "NOT_SERVING";
				// Drive the loop deterministically — accessing the private field
				// would require a friend; instead we just call checkHealth()
				// twice to advance the tick logic in the public surface.
				// To keep the test independent of the timer, reach into the
				// private health checker via `as any` (acceptable for tests).
				const checker = (isolated as unknown as { healthChecker: { tick: () => Promise<void> } }).healthChecker;
				expect(checker).toBeTruthy();
				await checker.tick();
				await checker.tick();

				const result = await isolated.execute(makeNode(), makeCtx());
				expect(result.success).toBe(false);
				expect(result.errors).toBeInstanceOf(BlokError);
				const err = result.errors as BlokError;
				expect(err.errorCode).toBe("GRPC_RUNTIME_UNAVAILABLE");
				expect(err.category).toBe(ErrorCategory.DEPENDENCY);
				expect(err.retryable).toBe(true);
			} finally {
				isolated.close();
			}
		});

		it("executeStream() short-circuits with the same error and yields no events", async () => {
			const isolated = new GrpcRuntimeAdapter(
				makeAdapterConfig(mock.port, {
					healthCheckIntervalMs: 1,
					healthCheckFailureThreshold: 1,
				}),
			);
			try {
				healthOverride = () => "NOT_SERVING";
				const checker = (isolated as unknown as { healthChecker: { tick: () => Promise<void> } }).healthChecker;
				await checker.tick();

				const { events, result } = isolated.executeStream(makeNode(), makeCtx());
				const collected: DecodedExecuteEvent[] = [];
				for await (const ev of events) collected.push(ev);
				const final = await result;

				expect(collected).toHaveLength(0);
				expect(final.success).toBe(false);
				expect((final.errors as BlokError).errorCode).toBe("GRPC_RUNTIME_UNAVAILABLE");
			} finally {
				isolated.close();
			}
		});

		it("recovers automatically after the next successful health probe", async () => {
			const isolated = new GrpcRuntimeAdapter(
				makeAdapterConfig(mock.port, {
					healthCheckIntervalMs: 1,
					healthCheckFailureThreshold: 1,
				}),
			);
			try {
				const checker = (isolated as unknown as { healthChecker: { tick: () => Promise<void> } }).healthChecker;

				// Open the breaker.
				healthOverride = () => "NOT_SERVING";
				await checker.tick();
				const failed = await isolated.execute(makeNode(), makeCtx());
				expect(failed.success).toBe(false);
				expect((failed.errors as BlokError).errorCode).toBe("GRPC_RUNTIME_UNAVAILABLE");

				// Recover.
				healthOverride = null;
				await checker.tick();

				const ok = await isolated.execute(makeNode(), makeCtx());
				expect(ok.success).toBe(true);
			} finally {
				isolated.close();
			}
		});

		it("disables the loop entirely when healthCheckIntervalMs is 0", () => {
			const isolated = new GrpcRuntimeAdapter(makeAdapterConfig(mock.port, { healthCheckIntervalMs: 0 }));
			try {
				const checker = (isolated as unknown as { healthChecker: unknown }).healthChecker;
				expect(checker).toBeNull();
			} finally {
				isolated.close();
			}
		});
	});
});
