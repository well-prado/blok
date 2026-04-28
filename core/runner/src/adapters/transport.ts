import type { RuntimeKind } from "./RuntimeAdapter";
import type { Transport } from "./grpc/types";

/**
 * Resolve the transport to use for a given runtime kind from the environment.
 *
 * Precedence (most specific wins):
 *   1. `RUNTIME_<KIND>_TRANSPORT` — per-kind override
 *      e.g. `RUNTIME_PYTHON3_TRANSPORT=grpc`
 *   2. `RUNTIME_TRANSPORT` — global default
 *      e.g. `RUNTIME_TRANSPORT=grpc`
 *   3. The hard-coded fallback (`http` for now; flips to `grpc` in Phase 6).
 *
 * Pure function — reads `process.env` once per call so tests can override.
 *
 * @param kind The runtime kind (e.g. "python3").
 * @param env Optional env source (defaults to `process.env`). Tests can pass
 *            a stub map.
 * @returns Either `"http"` or `"grpc"`. Invalid values fall back to `"http"`.
 */
export function resolveTransportForKind(kind: RuntimeKind, env: NodeJS.ProcessEnv = process.env): Transport {
	const perKindKey = `RUNTIME_${kind.toUpperCase()}_TRANSPORT`;
	const perKind = env[perKindKey];
	if (perKind === "grpc" || perKind === "http") {
		return perKind;
	}

	const global = env.RUNTIME_TRANSPORT;
	if (global === "grpc" || global === "http") {
		return global;
	}

	// Phase 0 default: HTTP. Flips to gRPC in Phase 6 once parity is proven.
	return "http";
}

/**
 * Whether log streaming is enabled for runtime nodes. When true, the runner
 * routes runtime nodes through `GrpcRuntimeAdapter.executeStream` instead of
 * the unary `execute`, and `LogLine` frames flow into `RunTracker.addLog`
 * — surfacing live in Studio's `/__blok/runs/:id/stream` SSE endpoint.
 *
 * Streaming is a pure additive capability: when the env var is unset, the
 * legacy unary path runs unchanged. When enabled but the adapter doesn't
 * support streaming (e.g. HttpRuntimeAdapter), `RuntimeAdapterNode` falls
 * back to unary so misconfiguration never blocks execution.
 *
 * Recognized as truthy: `1`, `true`, `yes`, `on` (case-insensitive). Anything
 * else (including unset, empty, `0`, `false`) returns false.
 */
export function isStreamLogsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.BLOK_STREAM_LOGS;
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
