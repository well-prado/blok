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
