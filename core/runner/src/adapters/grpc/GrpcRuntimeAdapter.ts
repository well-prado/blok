import { BlokError, type Context, ErrorCategory, ErrorSeverity } from "@blokjs/shared";
import type { Client, ServiceError } from "@grpc/grpc-js";
import { Metadata } from "@grpc/grpc-js";
import type RunnerNode from "../../RunnerNode";
import type { ExecutionResult, RuntimeAdapter, RuntimeKind } from "../RuntimeAdapter";
import { GrpcClientPool } from "./GrpcClientPool";
import {
	type DecodedExecuteResponse,
	type ExecuteRequestProto,
	type ExecuteResponseProto,
	decodeExecuteResponse,
	encodeExecuteRequest,
} from "./GrpcCodec";
import { type GrpcErrorContext, toBlokError } from "./GrpcErrors";
import type { GrpcAdapterConfig } from "./types";

/**
 * Runtime adapter that executes a node by calling
 * `blok.runtime.v1.NodeRuntime/Execute` over gRPC.
 *
 * Sibling to {@link HttpRuntimeAdapter}. Implements the same
 * {@link RuntimeAdapter} interface, so {@link Configuration} can swap between
 * transports based on env without any caller change.
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
	private readonly config: GrpcAdapterConfig;
	private readonly pool: GrpcClientPool;
	private readonly ownsPool: boolean;

	constructor(config: GrpcAdapterConfig, pool?: GrpcClientPool) {
		this.kind = config.kind;
		this.config = config;
		this.pool = pool ?? new GrpcClientPool();
		this.ownsPool = pool === undefined;
	}

	async execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult> {
		const startTime = performance.now();
		const stepInfo = readStepInfo(ctx);
		const deadlineMs = readPerCallDeadline(ctx) ?? this.config.defaultDeadlineMs;

		const request = encodeExecuteRequest(node, ctx, stepInfo.index, stepInfo.total, stepInfo.depth, deadlineMs);
		const requestBytes = approximateRequestBytes(request);

		const client = this.pool.get(this.config);

		try {
			const response = await this.unaryExecute(client, request, deadlineMs);
			const decoded = decodeExecuteResponse(response);
			return this.toExecutionResult(decoded, requestBytes, performance.now() - startTime);
		} catch (err) {
			const blokError = toBlokError(err, this.errorContext(node));
			return {
				success: false,
				data: null,
				errors: blokError,
				metrics: {
					duration_ms: performance.now() - startTime,
					request_bytes: requestBytes,
				} as ExecutionResult["metrics"],
			};
		}
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

	/** Close the underlying client pool. Only effective when the pool is owned. */
	close(): void {
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
