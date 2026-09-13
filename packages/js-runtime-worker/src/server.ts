/**
 * The persistent JavaScript runtime worker (ADR 0016 §3).
 *
 * One long-lived process per execution target serving `blok.runtime.v1` over
 * gRPC — the same contract the eleven language SDKs serve and the same client
 * (`GrpcRuntimeAdapter`) dials. It is deliberately engine-agnostic: the exact
 * same file runs under Node.js, Bun, and Deno, because `@grpc/grpc-js` is pure
 * JavaScript over `node:http2`, which all three implement.
 *
 * What it does NOT do: spawn anything per step. Every execution runs inside
 * this process, bounded by a concurrency gate.
 */

import { fileURLToPath } from "node:url";
import type { JavaScriptRuntime } from "@blokjs/shared";
import {
	type ChannelOptions,
	type GrpcObject,
	Metadata,
	Server,
	ServerCredentials,
	type ServerUnaryCall,
	type ServerWritableStream,
	type ServiceDefinition,
	type UntypedHandleCall,
	loadPackageDefinition,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { BLOB_CAPABILITY, resolveBlobDir, resolveClaimCheck } from "./claimCheck.js";
import { type NodeErrorEnvelope, WorkerError, toNodeError } from "./errors.js";
import {
	PROTOCOL_VERSION,
	buildRuntimeCapabilityManifest,
	detectHostRuntime,
	detectHostVersion,
	runtimeKindOf,
	sdkNameOf,
} from "./host.js";
import type { ExecuteContextProjection, WorkerExecution, WorkerRegistry } from "./registry.js";

/** gRPC metadata key carrying this worker's runtime capability manifest JSON
 * on every `ListNodes` response. Additive: the proto is unchanged, and a
 * client that ignores the header sees the base contract. */
export const RUNTIME_MANIFEST_METADATA_KEY = "blok-runtime-manifest";

export const WORKER_DEFAULTS = {
	MAX_MESSAGE_BYTES: 16 * 1024 * 1024,
	MAX_CONCURRENCY: 64,
	MAX_QUEUE: 256,
	KEEPALIVE_TIME_MS: 10_000,
	KEEPALIVE_TIMEOUT_MS: 5_000,
	DEFAULT_DEADLINE_MS: 30_000,
	SHUTDOWN_GRACE_MS: 10_000,
} as const;

export interface WorkerServerOptions {
	registry: WorkerRegistry;
	host?: string;
	port: number;
	runtime?: JavaScriptRuntime;
	sdkVersion?: string;
	maxMessageBytes?: number;
	maxConcurrency?: number;
	maxQueue?: number;
	blobDir?: string | null;
	shutdownGraceMs?: number;
}

export interface WorkerHandle {
	/** Port actually bound (resolves `port: 0` to the ephemeral port). */
	readonly port: number;
	readonly runtime: JavaScriptRuntime;
	/** Drain in-flight calls, stop serving, and resolve once closed. */
	shutdown(): Promise<void>;
}

// =============================================================================
// Proto loading
// =============================================================================

let serviceDefinition: ServiceDefinition | null = null;

function nodeRuntimeService(): ServiceDefinition {
	if (serviceDefinition === null) {
		const protoPath = fileURLToPath(new URL("./proto/blok/runtime/v1/runtime.proto", import.meta.url));
		const descriptor = loadPackageDefinition(
			loadSync(protoPath, { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true }),
		) as unknown as GrpcObject;
		const namespace = ((descriptor.blok as GrpcObject).runtime as GrpcObject).v1 as GrpcObject;
		serviceDefinition = (namespace.NodeRuntime as unknown as { service: ServiceDefinition }).service;
	}
	return serviceDefinition;
}

// =============================================================================
// Bounded concurrency
// =============================================================================

/**
 * Concurrency gate with a bounded wait queue. Over BOTH limits the call is
 * rejected with a deterministic, retryable error instead of being queued
 * forever — backpressure the runner can see and act on.
 */
export class ConcurrencyGate {
	private active = 0;
	private readonly waiting: Array<() => void> = [];

	constructor(
		private readonly maxConcurrency: number,
		private readonly maxQueue: number,
	) {}

	async acquire(): Promise<void> {
		if (this.active < this.maxConcurrency) {
			this.active++;
			return;
		}
		if (this.waiting.length >= this.maxQueue) {
			throw new WorkerError(
				"WORKER_OVERLOADED",
				`Runtime worker is at capacity (${this.maxConcurrency} concurrent, ${this.maxQueue} queued)`,
				"RATE_LIMIT",
				503,
				true,
				"Reduce workflow concurrency, or raise BLOK_WORKER_MAX_CONCURRENCY / BLOK_WORKER_MAX_QUEUE on the worker.",
			);
		}
		await new Promise<void>((resolve) => this.waiting.push(resolve));
		this.active++;
	}

	release(): void {
		this.active--;
		const next = this.waiting.shift();
		if (next) next();
	}

	get inFlight(): number {
		return this.active;
	}
}

// =============================================================================
// Wire shapes (mirrors of the proto messages this server receives/returns)
// =============================================================================

interface ExecuteRequestWire {
	node?: { name?: string; type?: string; version?: string };
	inputs?: Buffer;
	step?: { name?: string; index?: number; total?: number; depth?: number };
	trigger?: {
		body?: Buffer;
		headers?: Record<string, string>;
		params?: Record<string, string>;
		query?: Record<string, string>;
		cookies?: Record<string, string>;
		method?: string;
		url?: string;
		baseUrl?: string;
		triggerKind?: string;
	};
	state?: { previousOutput?: Buffer; vars?: Buffer; env?: Record<string, string> };
	workflow?: { runId?: string; name?: string; path?: string };
	options?: { deadlineMs?: string | number };
}

interface ExecuteResponseWire {
	success: boolean;
	data: Buffer;
	contentType: string;
	error: NodeErrorEnvelope | null;
	varsDelta: Buffer;
	logs: Array<{ level: string; message: string; attributes: Record<string, string> }>;
	metrics: { durationMs: number; requestBytes: number; responseBytes: number };
}

function bufferToJson(buf: Buffer | undefined, field: string): unknown {
	if (!buf || buf.length === 0) return null;
	try {
		return JSON.parse(Buffer.from(buf).toString("utf8"));
	} catch (err) {
		throw new WorkerError(
			"INVALID_REQUEST_JSON",
			`${field} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
			"PROTOCOL",
			400,
		);
	}
}

function jsonToBuffer(value: unknown): Buffer {
	if (value === null || value === undefined) return Buffer.alloc(0);
	return Buffer.from(JSON.stringify(value), "utf8");
}

/** Effective deadline in ms: the earlier of the gRPC deadline and the
 * per-call `options.deadline_ms` the runner set. */
function effectiveDeadlineMs(call: { getDeadline?: () => number | Date }, optionDeadlineMs: number): number {
	const candidates: number[] = [];
	if (optionDeadlineMs > 0) candidates.push(optionDeadlineMs);
	const raw = call.getDeadline?.();
	if (raw !== undefined) {
		const at = raw instanceof Date ? raw.getTime() : raw;
		if (Number.isFinite(at) && at > 0) candidates.push(at - Date.now());
	}
	if (candidates.length === 0) return WORKER_DEFAULTS.DEFAULT_DEADLINE_MS;
	return Math.max(1, Math.min(...candidates));
}

// =============================================================================
// Server
// =============================================================================

export async function startWorkerServer(options: WorkerServerOptions): Promise<WorkerHandle> {
	const runtime = options.runtime ?? detectHostRuntime();
	const runtimeKind = `runtime.${runtimeKindOf(runtime)}`;
	const sdk = sdkNameOf(runtime);
	const sdkVersion = options.sdkVersion ?? detectHostVersion(runtime);
	const maxMessageBytes = options.maxMessageBytes ?? WORKER_DEFAULTS.MAX_MESSAGE_BYTES;
	const registry = options.registry;
	const gate = new ConcurrencyGate(
		options.maxConcurrency ?? WORKER_DEFAULTS.MAX_CONCURRENCY,
		options.maxQueue ?? WORKER_DEFAULTS.MAX_QUEUE,
	);
	const blobDir = options.blobDir === undefined ? resolveBlobDir() : options.blobDir;
	const manifestJson = JSON.stringify(buildRuntimeCapabilityManifest({ runtime, maxMessageBytes }));
	let draining = false;

	/** Decode one request, resolve any claim-check, and run the node. */
	async function runCall(call: {
		request: ExecuteRequestWire;
		getDeadline?: () => number | Date;
		on(ev: string, fn: () => void): unknown;
	}): Promise<{ execution: WorkerExecution; requestBytes: number; durationMs: number; nodeName: string }> {
		const request = call.request;
		const nodeName = request.node?.name ?? "";
		if (nodeName.length === 0) {
			throw new WorkerError("INVALID_REQUEST", "ExecuteRequest.node.name is required", "PROTOCOL", 400);
		}
		const requestBytes = request.inputs?.length ?? 0;
		if (requestBytes > maxMessageBytes) {
			throw new WorkerError(
				"REQUEST_TOO_LARGE",
				`inputs are ${requestBytes} bytes, over this worker's ${maxMessageBytes}-byte limit`,
				"DATA",
				413,
			);
		}

		const inputs = resolveClaimCheck(bufferToJson(request.inputs, "inputs") ?? {}, blobDir, maxMessageBytes);
		const trigger = request.trigger ?? {};
		const projection: ExecuteContextProjection = {
			inputs,
			stepName: request.step?.name || nodeName,
			request: {
				body: bufferToJson(trigger.body, "trigger.body") ?? {},
				headers: trigger.headers ?? {},
				params: trigger.params ?? {},
				query: trigger.query ?? {},
				cookies: trigger.cookies ?? {},
				method: trigger.method ?? "",
				url: trigger.url ?? "",
				baseUrl: trigger.baseUrl ?? "",
			} as unknown as ExecuteContextProjection["request"],
			env: request.state?.env ?? {},
			runId: request.workflow?.runId ?? "",
			workflowName: request.workflow?.name ?? "",
			workflowPath: request.workflow?.path ?? "",
			signal: undefined as unknown as AbortSignal,
		};

		const deadlineMs = effectiveDeadlineMs(call, Number(request.options?.deadlineMs ?? 0));
		const controller = new AbortController();
		projection.signal = controller.signal;
		const timer = setTimeout(() => controller.abort(), deadlineMs);
		const onCancel = () => controller.abort();
		call.on("cancelled", onCancel);

		const started = Date.now();
		// `acquired` guards the release: an overload rejection never took a slot,
		// but it still has to clear the deadline timer, which was armed before
		// the gate so that queueing time counts against the caller's deadline.
		const deadlineError = () =>
			new WorkerError(
				"NODE_DEADLINE_EXCEEDED",
				`Node "${nodeName}" exceeded its ${deadlineMs}ms deadline`,
				"TIMEOUT",
				504,
				true,
				"Raise the step's maxDuration, or make the node honour ctx.signal and return earlier.",
			);
		let acquired = false;
		try {
			await gate.acquire();
			acquired = true;
			// The deadline can expire while this call is QUEUED, and an
			// `abort` listener attached after the fact never fires — so the
			// already-aborted case has to be checked, not just listened for.
			if (controller.signal.aborted) throw deadlineError();
			const execution = await Promise.race([
				registry.execute(nodeName, projection),
				new Promise<never>((_resolve, reject) => {
					controller.signal.addEventListener("abort", () => reject(deadlineError()), { once: true });
				}),
			]);
			return { execution, requestBytes, durationMs: Date.now() - started, nodeName };
		} finally {
			if (acquired) gate.release();
			clearTimeout(timer);
		}
	}

	function encode(result: {
		execution: WorkerExecution;
		requestBytes: number;
		durationMs: number;
		nodeName: string;
	}): ExecuteResponseWire {
		const { execution } = result;
		const data = execution.success ? jsonToBuffer(execution.data) : Buffer.alloc(0);
		if (data.length > maxMessageBytes) {
			return errorResponse(
				new WorkerError(
					"OUTPUT_TOO_LARGE",
					`Node "${result.nodeName}" returned ${data.length} bytes, over this worker's ${maxMessageBytes}-byte limit`,
					"DATA",
					413,
				),
				result.nodeName,
				result,
			);
		}
		return {
			success: execution.success,
			data,
			contentType: execution.contentType,
			error: execution.success
				? null
				: toNodeError(execution.error, { node: result.nodeName, sdk, sdkVersion, runtimeKind }),
			varsDelta: Object.keys(execution.varsDelta).length > 0 ? jsonToBuffer(execution.varsDelta) : Buffer.alloc(0),
			logs: execution.logs,
			metrics: { durationMs: result.durationMs, requestBytes: result.requestBytes, responseBytes: data.length },
		};
	}

	function errorResponse(
		error: unknown,
		nodeName: string,
		partial?: { requestBytes: number; durationMs: number },
	): ExecuteResponseWire {
		return {
			success: false,
			data: Buffer.alloc(0),
			contentType: "application/json",
			error: toNodeError(error, { node: nodeName, sdk, sdkVersion, runtimeKind }),
			varsDelta: Buffer.alloc(0),
			logs: [],
			metrics: { durationMs: partial?.durationMs ?? 0, requestBytes: partial?.requestBytes ?? 0, responseBytes: 0 },
		};
	}

	const handlers: Record<string, UntypedHandleCall> = {
		Health: ((_call: ServerUnaryCall<unknown, unknown>, callback: (err: unknown, res?: unknown) => void): void => {
			callback(null, {
				status: draining ? "NOT_SERVING" : "SERVING",
				sdkVersion,
				registeredNodes: registry.names(),
			});
		}) as unknown as UntypedHandleCall,

		ListNodes: ((
			_call: ServerUnaryCall<unknown, unknown>,
			callback: (err: unknown, res?: unknown, trailer?: Metadata, flags?: number) => void,
		): void => {
			const metadata = new Metadata();
			metadata.set(RUNTIME_MANIFEST_METADATA_KEY, manifestJson);
			_call.sendMetadata?.(metadata);
			callback(null, {
				nodes: registry.descriptors().map((d) => ({
					name: d.name,
					description: d.description,
					inputSchemaJson: jsonToBuffer(d.inputSchema),
					outputSchemaJson: jsonToBuffer(d.outputSchema),
					tags: d.tags,
					capabilityManifestJson: d.capabilityManifest === null ? Buffer.alloc(0) : jsonToBuffer(d.capabilityManifest),
				})),
				sdkName: sdk,
				sdkVersion,
				protoVersion: PROTOCOL_VERSION,
				capabilities: blobDir === null ? [] : [BLOB_CAPABILITY],
			});
		}) as unknown as UntypedHandleCall,

		Execute: ((
			call: ServerUnaryCall<ExecuteRequestWire, ExecuteResponseWire>,
			callback: (err: unknown, res?: ExecuteResponseWire) => void,
		): void => {
			runCall(call as never)
				.then((result) => callback(null, encode(result)))
				.catch((err) => callback(null, errorResponse(err, call.request?.node?.name ?? "")));
		}) as unknown as UntypedHandleCall,

		ExecuteStream: ((call: ServerWritableStream<ExecuteRequestWire, unknown>): void => {
			call.write({ started: { at: nowTimestamp() } });
			runCall(call as never)
				.then((result) => {
					for (const log of result.execution.logs) {
						call.write({ log: { ...log, timestamp: nowTimestamp() } });
					}
					call.write({ final: encode(result) });
					call.end();
				})
				.catch((err) => {
					call.write({ final: errorResponse(err, call.request?.node?.name ?? "") });
					call.end();
				});
		}) as unknown as UntypedHandleCall,
	};

	const channelOptions: ChannelOptions = {
		"grpc.max_receive_message_length": maxMessageBytes,
		"grpc.max_send_message_length": maxMessageBytes,
		"grpc.keepalive_time_ms": WORKER_DEFAULTS.KEEPALIVE_TIME_MS,
		"grpc.keepalive_timeout_ms": WORKER_DEFAULTS.KEEPALIVE_TIMEOUT_MS,
		"grpc.keepalive_permit_without_calls": 1,
	};

	const server = new Server(channelOptions);
	server.addService(nodeRuntimeService(), handlers);

	const host = options.host ?? "127.0.0.1";
	const boundPort = await new Promise<number>((resolve, reject) => {
		server.bindAsync(`${host}:${options.port}`, ServerCredentials.createInsecure(), (err, port) => {
			if (err) reject(err);
			else resolve(port);
		});
	});

	const graceMs = options.shutdownGraceMs ?? WORKER_DEFAULTS.SHUTDOWN_GRACE_MS;
	return {
		port: boundPort,
		runtime,
		async shutdown(): Promise<void> {
			// Readiness flips FIRST so an orchestrator's health probe stops
			// routing new work while in-flight calls drain.
			draining = true;
			await new Promise<void>((resolve) => {
				const forced = setTimeout(() => {
					server.forceShutdown();
					resolve();
				}, graceMs);
				server.tryShutdown(() => {
					clearTimeout(forced);
					resolve();
				});
			});
		},
	};
}

function nowTimestamp(): { seconds: number; nanos: number } {
	const now = Date.now();
	return { seconds: Math.floor(now / 1000), nanos: (now % 1000) * 1_000_000 };
}
