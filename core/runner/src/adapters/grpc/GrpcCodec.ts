import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@blokjs/shared";
import { type GrpcObject, type ServiceClientConstructor, loadPackageDefinition } from "@grpc/grpc-js";
import { type Options, loadSync } from "@grpc/proto-loader";
import type RunnerNode from "../../RunnerNode";

// =============================================================================
// Proto loading — single point of I/O in this module
// =============================================================================

/**
 * Resolve the path to `runtime.proto`. Prefers the dist-bundled copy at
 * runtime; falls back to the src copy when running from source.
 */
function resolveProtoPath(): string {
	// `import.meta.url` works under both Node ESM and Bun. The dist copy
	// sits next to the compiled JS; src copy sits next to TS source.
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(here, "proto/blok/runtime/v1/runtime.proto");
}

/** Options for `@grpc/proto-loader` — chosen for fidelity with our schema. */
const PROTO_LOADER_OPTIONS: Options = {
	keepCase: false, // snake_case in proto -> camelCase in JS for ergonomic field access
	longs: String,
	enums: String,
	defaults: true,
	oneofs: true,
	includeDirs: [],
};

/** Loaded once at module init; reused for every encode/decode. */
const PROTO_PATH = resolveProtoPath();
const PACKAGE_DEFINITION = loadSync(PROTO_PATH, PROTO_LOADER_OPTIONS);
const PROTO_DESCRIPTOR = loadPackageDefinition(PACKAGE_DEFINITION) as unknown as GrpcObject;

/** Path to the `NodeRuntime` service constructor inside the loaded proto. */
const NODE_RUNTIME_NAMESPACE = ((PROTO_DESCRIPTOR.blok as GrpcObject).runtime as GrpcObject).v1 as GrpcObject;

/**
 * The {@link NodeRuntime} service client constructor — used by
 * {@link GrpcClientPool} to instantiate clients.
 */
export const NodeRuntimeService = NODE_RUNTIME_NAMESPACE.NodeRuntime as unknown as ServiceClientConstructor;

// =============================================================================
// Wire types — hand-written to mirror the proto in `runtime.proto`.
//
// These are NOT generated. They are an authoritative TypeScript description
// of the proto messages so the rest of the codebase has type safety without
// a codegen step. CI verifies parity via the byte-level proto golden tests.
// =============================================================================

export interface ExecuteRequestProto {
	node: NodeRefProto;
	inputs: Buffer;
	step: StepInfoProto;
	trigger: TriggerInfoProto;
	state: RuntimeStateProto;
	workflow: WorkflowInfoProto;
	options: ExecuteOptionsProto;
}

export interface NodeRefProto {
	name: string;
	type: string;
	version: string;
}

export interface StepInfoProto {
	name: string;
	index: number;
	total: number;
	depth: number;
}

export interface TriggerInfoProto {
	body: Buffer;
	headers: Record<string, string>;
	params: Record<string, string>;
	query: Record<string, string>;
	cookies: Record<string, string>;
	method: string;
	url: string;
	baseUrl: string;
	triggerKind: string;
}

export interface RuntimeStateProto {
	previousOutput: Buffer;
	vars: Buffer;
	env: Record<string, string>;
}

export interface WorkflowInfoProto {
	runId: string;
	name: string;
	path: string;
	version: string;
	startedAt: { seconds: string; nanos: number } | null;
}

export interface ExecuteOptionsProto {
	deadlineMs: string; // proto int64 marshaled as string by proto-loader
	streamLogs: boolean;
	captureMetrics: boolean;
	hints: Record<string, string>;
}

export interface ExecuteResponseProto {
	success: boolean;
	data: Buffer;
	contentType: string;
	error: NodeErrorProto | null;
	varsDelta: Buffer;
	logs: LogLineProto[];
	metrics: MetricsProto | null;
}

export interface NodeErrorProto {
	code: string;
	category: string;
	severity: string;
	node: string;
	sdk: string;
	sdkVersion: string;
	runtimeKind: string;
	at: { seconds: string; nanos: number } | null;
	message: string;
	description: string;
	remediation: string;
	docUrl: string;
	causes: NodeErrorProto[];
	stack: string;
	contextSnapshotJson: Buffer;
	httpStatus: number;
	retryable: boolean;
	retryAfterMs: string;
	detailsJson: Buffer;
}

export interface LogLineProto {
	timestamp: { seconds: string; nanos: number } | null;
	level: string;
	message: string;
	attributes: Record<string, string>;
}

export interface MetricsProto {
	durationMs: number;
	cpuMs: number;
	memoryBytes: string;
	requestBytes: string;
	responseBytes: string;
}

// =============================================================================
// Decoded shape — what the adapter consumes after decoding the proto response
// =============================================================================

export interface DecodedExecuteResponse {
	readonly success: boolean;
	readonly data: unknown;
	readonly contentType: string;
	readonly varsDelta: Record<string, unknown>;
	readonly logs: ReadonlyArray<DecodedLogLine>;
	readonly error: DecodedNodeError | null;
	readonly metrics: DecodedMetrics;
}

export interface DecodedLogLine {
	readonly timestamp: number; // ms since epoch
	readonly level: string;
	readonly message: string;
	readonly attributes: Record<string, string>;
}

export interface DecodedNodeError {
	readonly code: string;
	readonly category: string;
	readonly severity: string;
	readonly node: string;
	readonly sdk: string;
	readonly sdkVersion: string;
	readonly runtimeKind: string;
	readonly at: number;
	readonly message: string;
	readonly description: string;
	readonly remediation: string;
	readonly docUrl: string;
	readonly causes: ReadonlyArray<DecodedNodeError>;
	readonly stack: string;
	readonly contextSnapshot: unknown;
	readonly httpStatus: number;
	readonly retryable: boolean;
	readonly retryAfterMs: number;
	readonly details: unknown;
}

export interface DecodedMetrics {
	readonly durationMs: number;
	readonly cpuMs: number;
	readonly memoryBytes: number;
	readonly requestBytes: number;
	readonly responseBytes: number;
}

// =============================================================================
// Encoder — Context + RunnerNode → proto ExecuteRequest
// =============================================================================

/**
 * Encode a workflow {@link Context} and a {@link RunnerNode} into a
 * {@link ExecuteRequestProto} ready for the gRPC wire.
 *
 * Pure function — no I/O. The opaque JSON-shaped fields (`inputs`,
 * `previous_output`, `vars`, body) are serialized to UTF-8 bytes here so the
 * SDK side can JSON-decode lazily.
 *
 * Critically, `inputs` is the resolved node config (from the Blueprint
 * Mapper) sent UNWRAPPED — no `{inputs:{...}}` envelope. This closes the
 * `BLOK_FRAMEWORK_FIXES.md` #3 unwrap-hack family of bugs at the wire format
 * layer.
 */
export function encodeExecuteRequest(
	node: RunnerNode,
	ctx: Context,
	stepIndex: number,
	stepTotal: number,
	stepDepth: number,
	deadlineMs: number,
): ExecuteRequestProto {
	const resolvedInputs = extractResolvedInputs(ctx, node.name);
	const previousOutput = ctx.response?.data ?? null;
	const vars = ctx.vars ?? {};
	const env = stringEnv(ctx.env as Record<string, unknown> | undefined);

	const request = ctx.request ?? ({} as Context["request"]);
	const requestBody = (request as { body?: unknown }).body;

	return {
		node: {
			name: node.node,
			type: node.type ?? "",
			version: "",
		},
		inputs: jsonToBuffer(resolvedInputs),
		step: {
			name: node.name,
			index: stepIndex,
			total: stepTotal,
			depth: stepDepth,
		},
		trigger: {
			body: bodyToBuffer(requestBody),
			headers: stringMap((request as { headers?: unknown }).headers),
			params: stringMap((request as { params?: unknown }).params),
			query: stringMap((request as { query?: unknown }).query),
			cookies: stringMap((request as { cookies?: unknown }).cookies),
			method: stringField((request as { method?: unknown }).method),
			url: stringField((request as { url?: unknown }).url),
			baseUrl: stringField((request as { baseUrl?: unknown }).baseUrl),
			triggerKind: "",
		},
		state: {
			previousOutput: jsonToBuffer(previousOutput),
			vars: jsonToBuffer(vars),
			env,
		},
		workflow: {
			runId: ctx.id,
			name: ctx.workflow_name ?? "",
			path: ctx.workflow_path ?? "",
			version: "",
			startedAt: null,
		},
		options: {
			deadlineMs: String(deadlineMs),
			streamLogs: false,
			captureMetrics: true,
			hints: {},
		},
	};
}

// =============================================================================
// Decoder — proto ExecuteResponse → DecodedExecuteResponse
// =============================================================================

/**
 * Decode a {@link ExecuteResponseProto} from the wire into the shape the
 * adapter consumes. Defensive against missing fields (proto-loader fills in
 * defaults, but we guard against malformed responses too).
 */
export function decodeExecuteResponse(response: ExecuteResponseProto): DecodedExecuteResponse {
	return {
		success: response.success ?? false,
		data: bufferToJson(response.data),
		contentType: response.contentType || "application/json",
		varsDelta: (bufferToJson(response.varsDelta) as Record<string, unknown> | null) ?? {},
		logs: (response.logs ?? []).map(decodeLogLine),
		error: response.error ? decodeNodeError(response.error) : null,
		metrics: decodeMetrics(response.metrics),
	};
}

function decodeLogLine(line: LogLineProto): DecodedLogLine {
	return {
		timestamp: timestampToMs(line.timestamp),
		level: line.level,
		message: line.message,
		attributes: line.attributes ?? {},
	};
}

function decodeNodeError(err: NodeErrorProto): DecodedNodeError {
	return {
		code: err.code,
		category: err.category,
		severity: err.severity,
		node: err.node,
		sdk: err.sdk,
		sdkVersion: err.sdkVersion,
		runtimeKind: err.runtimeKind,
		at: timestampToMs(err.at),
		message: err.message,
		description: err.description,
		remediation: err.remediation,
		docUrl: err.docUrl,
		causes: (err.causes ?? []).map(decodeNodeError),
		stack: err.stack,
		contextSnapshot: bufferToJson(err.contextSnapshotJson),
		httpStatus: err.httpStatus,
		retryable: err.retryable,
		retryAfterMs: Number(err.retryAfterMs ?? 0),
		details: bufferToJson(err.detailsJson),
	};
}

function decodeMetrics(metrics: MetricsProto | null): DecodedMetrics {
	return {
		durationMs: metrics?.durationMs ?? 0,
		cpuMs: metrics?.cpuMs ?? 0,
		memoryBytes: Number(metrics?.memoryBytes ?? 0),
		requestBytes: Number(metrics?.requestBytes ?? 0),
		responseBytes: Number(metrics?.responseBytes ?? 0),
	};
}

// =============================================================================
// Internal serialization helpers
// =============================================================================

/**
 * Pull resolved node inputs from `ctx.config[nodeName].inputs` (the shape
 * established by the Blueprint Mapper) and return them as a plain object.
 *
 * Falls back to `ctx.response.data` when no resolved inputs exist (matches
 * the legacy zero-config-chaining behavior of `HttpRuntimeAdapter`).
 */
function extractResolvedInputs(ctx: Context, nodeName: string): unknown {
	const nodeConfig = ctx.config
		? ((ctx.config as Record<string, unknown>)[nodeName] as Record<string, unknown> | undefined)
		: undefined;
	const resolved = nodeConfig?.inputs;
	if (resolved !== undefined) return resolved;
	return ctx.response?.data ?? {};
}

/** Encode a value as UTF-8 JSON bytes. `null`/`undefined` → empty buffer. */
export function jsonToBuffer(value: unknown): Buffer {
	if (value === null || value === undefined) return Buffer.alloc(0);
	return Buffer.from(JSON.stringify(value), "utf-8");
}

/** Decode a buffer as UTF-8 JSON. Empty/missing buffer → `null`. */
export function bufferToJson(buf: Buffer | undefined): unknown {
	if (!buf || buf.length === 0) return null;
	try {
		return JSON.parse(buf.toString("utf-8"));
	} catch {
		// Malformed JSON — return raw string so callers can salvage what they can.
		return buf.toString("utf-8");
	}
}

/**
 * Encode a request body. Strings stay UTF-8; objects become JSON; Buffers
 * pass through. Anything else stringifies via JSON.
 */
function bodyToBuffer(body: unknown): Buffer {
	if (body === null || body === undefined) return Buffer.alloc(0);
	if (Buffer.isBuffer(body)) return body;
	if (typeof body === "string") return Buffer.from(body, "utf-8");
	return Buffer.from(JSON.stringify(body), "utf-8");
}

/** Coerce an unknown record-like value into `Record<string, string>`. */
function stringMap(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object") return {};
	const out: Record<string, string> = {};
	for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
		if (typeof val === "string") out[key] = val;
		else if (val !== null && val !== undefined) out[key] = String(val);
	}
	return out;
}

/** Coerce an unknown value into a string field; default empty. */
function stringField(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Filter env to string-valued entries (process.env can carry undefined). */
function stringEnv(env: Record<string, unknown> | undefined): Record<string, string> {
	if (!env) return {};
	const out: Record<string, string> = {};
	for (const [key, val] of Object.entries(env)) {
		if (typeof val === "string") out[key] = val;
	}
	return out;
}

/** Convert a proto Timestamp to ms-since-epoch. */
function timestampToMs(ts: { seconds: string; nanos: number } | null | undefined): number {
	if (!ts) return 0;
	const seconds = Number(ts.seconds ?? 0);
	const nanos = ts.nanos ?? 0;
	return seconds * 1000 + Math.floor(nanos / 1_000_000);
}
