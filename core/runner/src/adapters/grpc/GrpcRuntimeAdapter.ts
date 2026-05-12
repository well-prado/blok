import { BlokError, type Context, ErrorCategory, ErrorSeverity } from "@blokjs/shared";
import type { ClientReadableStream, ServiceError } from "@grpc/grpc-js";
import { type Client, Metadata } from "@grpc/grpc-js";
import { SpanStatusCode, type Tracer, trace } from "@opentelemetry/api";
import type RunnerNode from "../../RunnerNode";
import type { ExecutionResult, RuntimeAdapter, RuntimeKind } from "../RuntimeAdapter";
import { GrpcClientPool } from "./GrpcClientPool";
import {
	type DecodedExecuteEvent,
	type DecodedExecuteResponse,
	type ExecuteEventProto,
	type ExecuteRequestProto,
	type ExecuteResponseProto,
	decodeExecuteEvent,
	decodeExecuteResponse,
	encodeExecuteRequest,
} from "./GrpcCodec";
import { type GrpcErrorContext, toBlokError } from "./GrpcErrors";
import { GrpcHealthChecker } from "./GrpcHealthChecker";
import { GRPC_DEFAULTS, type GrpcAdapterConfig } from "./types";

/**
 * Runtime adapter that executes a node by calling
 * `blok.runtime.v1.NodeRuntime/Execute` over gRPC. The sole runtime
 * transport since v0.5 (the HTTP adapter was removed alongside the
 * `RUNTIME_TRANSPORT=http` opt-in).
 *
 * Implements the {@link RuntimeAdapter} interface so the registry,
 * `RuntimeAdapterNode`, and {@link Configuration} treat it identically
 * to the in-process `NodeJsRuntimeAdapter`.
 *
 * Single Responsibility: orchestrate the unary `Execute` RPC.
 *
 * Encoding/decoding is delegated to {@link GrpcCodec}; error mapping to
 * {@link GrpcErrors}; client lifetime to {@link GrpcClientPool}; channel
 * options to {@link GrpcChannelOptions}.
 *
 * @example
 *   const adapter = new GrpcRuntimeAdapter({
 *     kind: "python3",
 *     host: "localhost",
 *     port: 10007,
 *     defaultDeadlineMs: 30_000,
 *     maxMessageBytes: 16 * 1024 * 1024,
 *     keepalive: { timeMs: 10000, timeoutMs: 5000, permitWithoutCalls: true },
 *   });
 *   const result = await adapter.execute(node, ctx);
 */
export class GrpcRuntimeAdapter implements RuntimeAdapter {
	readonly kind: RuntimeKind;
	readonly transport = "grpc" as const;
	private readonly config: GrpcAdapterConfig;
	private readonly pool: GrpcClientPool;
	private readonly ownsPool: boolean;
	private readonly healthChecker: GrpcHealthChecker | null;
	private readonly tracer: Tracer;

	constructor(config: GrpcAdapterConfig, pool?: GrpcClientPool) {
		this.kind = config.kind;
		this.config = config;
		this.pool = pool ?? new GrpcClientPool();
		this.ownsPool = pool === undefined;
		this.healthChecker = this.buildHealthChecker();
		// `@opentelemetry/api` returns a no-op tracer when no OTEL SDK is
		// registered in the host process, so this is zero-cost when OTEL
		// isn't in use. When the host has OTEL set up, RPC spans nest
		// under whatever span is active when `execute()` is called
		// (typically the workflow span from `TriggerBase`).
		this.tracer = trace.getTracer("@blokjs/runner.grpc", "1.0.0");
	}

	/**
	 * Lazily start the background health-check loop. Operators can disable
	 * the loop with `healthCheckIntervalMs: 0`. Tests typically construct
	 * adapters without starting the loop and use {@link checkHealth}
	 * directly.
	 */
	startHealthCheck(): void {
		this.healthChecker?.start();
	}

	private buildHealthChecker(): GrpcHealthChecker | null {
		const intervalMs = this.config.healthCheckIntervalMs ?? GRPC_DEFAULTS.HEALTH_INTERVAL_MS;
		if (intervalMs <= 0) return null;
		const threshold = this.config.healthCheckFailureThreshold ?? GRPC_DEFAULTS.HEALTH_FAILURE_THRESHOLD;
		return new GrpcHealthChecker(() => this.checkHealth(), {
			intervalMs,
			failureThreshold: threshold,
		});
	}

	/** Build a typed `BlokError(category=DEPENDENCY)` for short-circuited calls. */
	private circuitOpenError(node: RunnerNode): BlokError {
		return BlokError.dependency({
			code: "GRPC_RUNTIME_UNAVAILABLE",
			message: `Runtime ${this.kind} unavailable — circuit breaker is open after consecutive Health failures`,
			description: `The background health probe could not reach ${this.config.host}:${this.config.port} for the configured failure threshold. Calls fail fast until a probe succeeds.`,
			remediation:
				"Check the SDK process is running and reachable, then wait for the next health probe to recover the circuit.",
			retryable: true,
			retryAfterMs: this.config.healthCheckIntervalMs ?? GRPC_DEFAULTS.HEALTH_INTERVAL_MS,
			contextSnapshot: {
				kind: this.kind,
				host: this.config.host,
				port: this.config.port,
				node: node.name,
			},
		});
	}

	async execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult> {
		const startTime = performance.now();

		// Fail fast when the circuit breaker has tripped — avoids stacking up
		// blocked calls on top of a known-unhealthy SDK.
		if (this.healthChecker && !this.healthChecker.isAvailable()) {
			return {
				success: false,
				data: null,
				errors: this.circuitOpenError(node),
				metrics: { duration_ms: performance.now() - startTime, request_bytes: 0 } as ExecutionResult["metrics"],
			};
		}

		const stepInfo = readStepInfo(ctx);
		const deadlineMs = readPerCallDeadline(ctx) ?? this.config.defaultDeadlineMs;

		const request = encodeExecuteRequest(node, ctx, stepInfo.index, stepInfo.total, stepInfo.depth, deadlineMs);
		const requestBytes = approximateRequestBytes(request);

		const client = this.pool.get(this.config);

		// Span attributes follow the OTEL gRPC semantic conventions so traces
		// from this adapter compose with general-purpose tooling out of the
		// box. The span is a child of whatever is active in `context.active()`
		// when `execute()` is called.
		const span = this.tracer.startSpan(`grpc.${this.kind}.Execute`, {
			attributes: {
				"rpc.system": "grpc",
				"rpc.service": "blok.runtime.v1.NodeRuntime",
				"rpc.method": "Execute",
				"net.peer.name": this.config.host,
				"net.peer.port": this.config.port,
				"blok.runtime.kind": this.kind,
				"blok.node.name": node.name,
				"blok.request.bytes": requestBytes,
			},
		});

		try {
			const response = await this.unaryExecute(client, request, deadlineMs);
			const decoded = decodeExecuteResponse(response);
			const result = this.toExecutionResult(decoded, requestBytes, performance.now() - startTime);
			span.setAttribute("blok.response.bytes", result.metrics?.response_bytes ?? 0);
			span.setStatus({ code: result.success ? SpanStatusCode.OK : SpanStatusCode.ERROR });
			return result;
		} catch (err) {
			const blokError = toBlokError(err, this.errorContext(node));
			span.recordException(blokError);
			span.setStatus({ code: SpanStatusCode.ERROR, message: blokError.message });
			return {
				success: false,
				data: null,
				errors: blokError,
				metrics: {
					duration_ms: performance.now() - startTime,
					request_bytes: requestBytes,
				} as ExecutionResult["metrics"],
			};
		} finally {
			span.end();
		}
	}

	/**
	 * Open a server-streaming `ExecuteStream` call and return both an
	 * AsyncIterable of decoded events AND a promise that resolves to the
	 * final {@link ExecutionResult} once the stream completes.
	 *
	 * Phase 5 capability: SDKs may emit `NodeStarted`, `LogLine`, `Progress`,
	 * and `PartialResult` events while a node executes; the stream always
	 * terminates with a single `final` event carrying the same
	 * {@link ExecuteResponseProto} that unary `Execute` would return.
	 *
	 * SDKs that don't implement streaming respond with gRPC `UNIMPLEMENTED`;
	 * the returned promise rejects with a {@link BlokError} of category
	 * `INTERNAL` (mapped from `UNIMPLEMENTED`) and the iterable yields nothing.
	 *
	 * Callers should consume the iterable in parallel with awaiting the
	 * promise — events are pushed live, while the promise gives the typed
	 * result for the rest of the runner pipeline.
	 *
	 * @example
	 *   const { events, result } = adapter.executeStream(node, ctx);
	 *   for await (const ev of events) {
	 *     if (ev.type === "log") tracker.appendLog(ev.log);
	 *   }
	 *   const final = await result;
	 */
	executeStream(
		node: RunnerNode,
		ctx: Context,
	): {
		events: AsyncIterable<DecodedExecuteEvent>;
		result: Promise<ExecutionResult>;
	} {
		const startTime = performance.now();

		// Mirror the unary fast-fail path so streaming callers see the same
		// circuit-breaker behavior. Returns an empty iterable + a pre-resolved
		// failure result so consumers' `for await` and `await result` patterns
		// both terminate immediately.
		if (this.healthChecker && !this.healthChecker.isAvailable()) {
			const blokError = this.circuitOpenError(node);
			const empty: AsyncIterable<DecodedExecuteEvent> = {
				[Symbol.asyncIterator]: async function* () {
					/* nothing to yield */
				},
			};
			return {
				events: empty,
				result: Promise.resolve({
					success: false,
					data: null,
					errors: blokError,
					metrics: { duration_ms: performance.now() - startTime, request_bytes: 0 } as ExecutionResult["metrics"],
				}),
			};
		}

		const stepInfo = readStepInfo(ctx);
		const deadlineMs = readPerCallDeadline(ctx) ?? this.config.defaultDeadlineMs;

		const request = encodeExecuteRequest(node, ctx, stepInfo.index, stepInfo.total, stepInfo.depth, deadlineMs);
		// Opt the SDK into emitting log frames (proto ExecuteOptions.stream_logs).
		request.options = { ...request.options, streamLogs: true };
		const requestBytes = approximateRequestBytes(request);

		const client = this.pool.get(this.config);
		const call = this.openExecuteStream(client, request, deadlineMs);

		// Streaming span lives for the lifetime of the call; ended in the
		// same `settle()` path that resolves the result promise so timing
		// captures the full server-streaming arc rather than just the first
		// frame.
		const span = this.tracer.startSpan(`grpc.${this.kind}.ExecuteStream`, {
			attributes: {
				"rpc.system": "grpc",
				"rpc.service": "blok.runtime.v1.NodeRuntime",
				"rpc.method": "ExecuteStream",
				"net.peer.name": this.config.host,
				"net.peer.port": this.config.port,
				"blok.runtime.kind": this.kind,
				"blok.node.name": node.name,
				"blok.request.bytes": requestBytes,
			},
		});

		let finalDecoded: DecodedExecuteResponse | null = null;
		const errorContext = this.errorContext(node);
		const failureResult = (err: unknown): ExecutionResult => {
			const blokError = err instanceof BlokError ? err : toBlokError(err, errorContext);
			return {
				success: false,
				data: null,
				errors: blokError,
				metrics: {
					duration_ms: performance.now() - startTime,
					request_bytes: requestBytes,
				} as ExecutionResult["metrics"],
			};
		};

		const events = decodedEventsFromCall(call, (decoded) => {
			if (decoded.type === "final") finalDecoded = decoded.response;
		});

		const result = new Promise<ExecutionResult>((resolve) => {
			let settled = false;
			const settle = (value: ExecutionResult): void => {
				if (settled) return;
				settled = true;
				if (value.success) {
					span.setAttribute("blok.response.bytes", value.metrics?.response_bytes ?? 0);
					span.setStatus({ code: SpanStatusCode.OK });
				} else {
					if (value.errors instanceof BlokError) span.recordException(value.errors);
					span.setStatus({
						code: SpanStatusCode.ERROR,
						message: value.errors instanceof Error ? value.errors.message : "stream failure",
					});
				}
				span.end();
				resolve(value);
			};

			call.on("error", (err) => settle(failureResult(err)));
			call.on("end", () => {
				if (finalDecoded) {
					settle(this.toExecutionResult(finalDecoded, requestBytes, performance.now() - startTime));
				} else {
					settle(failureResult(new Error("ExecuteStream ended without a final frame")));
				}
			});
		});

		return { events, result };
	}

	private openExecuteStream(
		client: Client,
		request: ExecuteRequestProto,
		deadlineMs: number,
	): ClientReadableStream<ExecuteEventProto> {
		const metadata = new Metadata();
		const deadline = new Date(Date.now() + deadlineMs);
		const callable = (
			client as unknown as {
				ExecuteStream: (
					request: ExecuteRequestProto,
					metadata: Metadata,
					options: { deadline: Date },
				) => ClientReadableStream<ExecuteEventProto>;
			}
		).ExecuteStream;
		return callable.call(client, request, metadata, { deadline });
	}

	/**
	 * Probe the SDK with `Health/Check`. Used by the health-check loop in
	 * `TriggerBase` and by the circuit breaker. Returns false on any failure
	 * (network, deadline, NOT_SERVING) — never throws.
	 */
	async checkHealth(): Promise<boolean> {
		const client = this.pool.get(this.config);
		try {
			const status = await this.unaryHealth(client);
			return status === "SERVING";
		} catch {
			return false;
		}
	}

	/**
	 * Close the underlying client pool and stop the health-check loop.
	 * Pool close is only effective when the pool is owned by this adapter.
	 */
	close(): void {
		this.healthChecker?.stop();
		if (this.ownsPool) this.pool.close();
	}

	// =========================================================================
	// Private RPC helpers
	// =========================================================================

	private unaryExecute(
		client: Client,
		request: ExecuteRequestProto,
		deadlineMs: number,
	): Promise<ExecuteResponseProto> {
		const metadata = new Metadata();
		const deadline = new Date(Date.now() + deadlineMs);

		return new Promise((resolve, reject) => {
			const callable = (
				client as unknown as {
					Execute: (
						request: ExecuteRequestProto,
						metadata: Metadata,
						options: { deadline: Date },
						callback: (err: ServiceError | null, response: ExecuteResponseProto) => void,
					) => void;
				}
			).Execute;

			callable.call(client, request, metadata, { deadline }, (err, response) => {
				if (err) reject(err);
				else resolve(response);
			});
		});
	}

	private unaryHealth(client: Client): Promise<string> {
		return new Promise((resolve, reject) => {
			const callable = (
				client as unknown as {
					Health: (
						request: { service: string },
						callback: (err: ServiceError | null, response: { status: string }) => void,
					) => void;
				}
			).Health;

			callable.call(client, { service: "blok.runtime.v1.NodeRuntime" }, (err, response) => {
				if (err) reject(err);
				else resolve(response.status);
			});
		});
	}

	// =========================================================================
	// Private mappers
	// =========================================================================

	private toExecutionResult(
		decoded: DecodedExecuteResponse,
		requestBytes: number,
		wallDurationMs: number,
	): ExecutionResult {
		return {
			success: decoded.success,
			data: decoded.data,
			errors: decoded.error
				? // The decoded NodeError is rich; the adapter pipeline expects an
					// `unknown | null` where instances of `GlobalError` are passed through.
					// We don't construct a BlokError here because `toBlokError` is the
					// authoritative entry point; payload-driven errors arrive via the
					// gRPC `Status.details` path in `unaryExecute`'s catch branch. When
					// an SDK returns success=false on the response body itself, we wrap
					// the decoded payload as a structured error.
					this.decodedErrorToBlokError(decoded.error)
				: null,
			logs: decoded.logs.map((l) => `[${l.level}] ${l.message}`),
			metrics: {
				duration_ms: decoded.metrics.durationMs > 0 ? decoded.metrics.durationMs : wallDurationMs,
				cpu_ms: decoded.metrics.cpuMs,
				memory_bytes: decoded.metrics.memoryBytes,
				request_bytes: requestBytes,
				response_bytes: decoded.metrics.responseBytes,
			} as ExecutionResult["metrics"],
			vars: decoded.varsDelta,
		};
	}

	private decodedErrorToBlokError(decoded: NonNullable<DecodedExecuteResponse["error"]>): BlokError {
		return BlokError.fromJSON({
			code: decoded.code,
			category: coerceCategory(decoded.category),
			severity: coerceSeverity(decoded.severity),
			node: decoded.node,
			sdk: decoded.sdk,
			sdkVersion: decoded.sdkVersion,
			runtimeKind: decoded.runtimeKind,
			at: new Date(decoded.at).toISOString(),
			message: decoded.message,
			description: decoded.description,
			remediation: decoded.remediation,
			docUrl: decoded.docUrl,
			causes: decoded.causes.map((c) => ({
				code: c.code,
				category: coerceCategory(c.category),
				severity: coerceSeverity(c.severity),
				node: c.node,
				sdk: c.sdk,
				sdkVersion: c.sdkVersion,
				runtimeKind: c.runtimeKind,
				at: new Date(c.at).toISOString(),
				message: c.message,
				description: c.description,
				remediation: c.remediation,
				docUrl: c.docUrl,
				causes: [],
				stack: c.stack,
				contextSnapshot: c.contextSnapshot,
				httpStatus: c.httpStatus,
				retryable: c.retryable,
				retryAfterMs: c.retryAfterMs,
				details: c.details,
			})),
			stack: decoded.stack,
			contextSnapshot: decoded.contextSnapshot,
			httpStatus: decoded.httpStatus,
			retryable: decoded.retryable,
			retryAfterMs: decoded.retryAfterMs,
			details: decoded.details,
		});
	}

	private errorContext(node: RunnerNode): GrpcErrorContext {
		return {
			node: node.name,
			sdk: `blok-${this.kind}`,
			sdkVersion: "",
			runtimeKind: `runtime.${this.kind}`,
		};
	}
}

/**
 * Coerce an unvalidated string into a known {@link ErrorCategory}, falling
 * back to `INTERNAL` when the SDK reports a value the runner doesn't know.
 */
function coerceCategory(raw: string): ErrorCategory {
	const known = Object.values(ErrorCategory) as string[];
	return known.includes(raw) ? (raw as ErrorCategory) : ErrorCategory.INTERNAL;
}

/** Coerce an unvalidated string into a known {@link ErrorSeverity}, defaulting to ERROR. */
function coerceSeverity(raw: string): ErrorSeverity {
	const known = Object.values(ErrorSeverity) as string[];
	return known.includes(raw) ? (raw as ErrorSeverity) : ErrorSeverity.ERROR;
}

/**
 * Read step metadata from `ctx._stepInfo` if populated by `RunnerSteps`.
 * Defaults to a single top-level step when absent — keeps the adapter usable
 * standalone (e.g. in tests).
 */
function readStepInfo(ctx: Context): { index: number; total: number; depth: number } {
	const meta = (ctx as Record<string, unknown>)._stepInfo as
		| { index?: number; total?: number; depth?: number }
		| undefined;
	return {
		index: meta?.index ?? 0,
		total: meta?.total ?? 1,
		depth: meta?.depth ?? 0,
	};
}

/** Read per-call deadline override from `ctx._stepDeadlineMs` if present. */
function readPerCallDeadline(ctx: Context): number | undefined {
	const value = (ctx as Record<string, unknown>)._stepDeadlineMs;
	return typeof value === "number" && value > 0 ? value : undefined;
}

/**
 * Wrap a `ClientReadableStream` of {@link ExecuteEventProto} as an
 * AsyncIterable of decoded events. Empty oneof frames are silently skipped.
 *
 * Each decoded event is also handed to `tap` so the caller (the adapter) can
 * snapshot terminal frames without needing to consume the iterable itself.
 *
 * Errors and stream end are NOT signalled through the iterable — callers
 * await the companion `result` promise for the typed terminal value.
 */
async function* decodedEventsFromCall(
	call: ClientReadableStream<ExecuteEventProto>,
	tap: (decoded: DecodedExecuteEvent) => void,
): AsyncIterable<DecodedExecuteEvent> {
	try {
		for await (const raw of call) {
			const decoded = decodeExecuteEvent(raw as ExecuteEventProto);
			if (decoded === null) continue;
			tap(decoded);
			yield decoded;
		}
	} catch {
		// The companion `result` promise carries the typed error; this catch
		// just terminates the iterable without bubbling up the raw gRPC error.
	}
}

/**
 * Cheap approximation of the on-wire request size. Sums the byte-buffer
 * fields plus a small constant for the typed envelope. Good enough for
 * observability; real wire size is reported in `Metrics.request_bytes`
 * (when the SDK populates it).
 */
function approximateRequestBytes(request: ExecuteRequestProto): number {
	return (
		request.inputs.length +
		request.state.previousOutput.length +
		request.state.vars.length +
		request.trigger.body.length
	);
}
