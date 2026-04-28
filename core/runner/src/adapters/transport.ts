import type { RuntimeKind } from "./RuntimeAdapter";
import type { TlsConfig, Transport } from "./grpc/types";

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
	return isTruthyFlag(env.BLOK_STREAM_LOGS);
}

/**
 * Resolve the gRPC background health-check interval from the environment.
 *
 * `BLOK_GRPC_HEALTH_INTERVAL_MS` is the global override:
 *   - any positive integer → use that interval
 *   - `0` → disable the loop entirely (useful in tests)
 *   - unset / non-numeric → return undefined; adapter uses
 *     {@link GRPC_DEFAULTS.HEALTH_INTERVAL_MS}.
 */
export function resolveHealthCheckIntervalMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env.BLOK_GRPC_HEALTH_INTERVAL_MS;
	if (raw === undefined || raw === "") return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed < 0) return undefined;
	return parsed;
}

/**
 * Resolve the consecutive-failure threshold for the gRPC circuit breaker.
 *
 * `BLOK_GRPC_HEALTH_FAILURE_THRESHOLD` overrides the default
 * ({@link GRPC_DEFAULTS.HEALTH_FAILURE_THRESHOLD}). Values < 1 are ignored
 * (the checker requires ≥ 1 failure to trip).
 */
export function resolveHealthCheckFailureThreshold(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env.BLOK_GRPC_HEALTH_FAILURE_THRESHOLD;
	if (raw === undefined || raw === "") return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed < 1) return undefined;
	return parsed;
}

/**
 * Build a {@link TlsConfig} for a given runtime kind from environment
 * variables. Returns `undefined` when nothing is configured (channel stays
 * plaintext — appropriate for loopback dev).
 *
 * Per-kind env vars (taking precedence):
 *   - `RUNTIME_<KIND>_TLS_CA`              CA cert path (PEM)
 *   - `RUNTIME_<KIND>_TLS_CLIENT_CERT`     client cert path (PEM, mTLS)
 *   - `RUNTIME_<KIND>_TLS_CLIENT_KEY`      client key path (PEM, mTLS)
 *   - `RUNTIME_<KIND>_TLS_SERVER_NAME`     SNI override
 *   - `RUNTIME_<KIND>_TLS_INSECURE_SKIP_VERIFY=true`  dev-only
 *
 * Global fallbacks (apply when the per-kind var is unset):
 *   - `BLOK_GRPC_TLS_CA`, `BLOK_GRPC_TLS_CLIENT_CERT`, `BLOK_GRPC_TLS_CLIENT_KEY`,
 *     `BLOK_GRPC_TLS_SERVER_NAME`, `BLOK_GRPC_TLS_INSECURE_SKIP_VERIFY`.
 *
 * If none of the relevant env vars are set, returns `undefined`.
 */
export function loadTlsConfigForKind(kind: RuntimeKind, env: NodeJS.ProcessEnv = process.env): TlsConfig | undefined {
	const upperKind = kind.toUpperCase();
	const pick = (suffix: string): string | undefined =>
		env[`RUNTIME_${upperKind}_TLS_${suffix}`] ?? env[`BLOK_GRPC_TLS_${suffix}`];

	const caCertPath = pick("CA");
	const clientCertPath = pick("CLIENT_CERT");
	const clientKeyPath = pick("CLIENT_KEY");
	const serverNameOverride = pick("SERVER_NAME");
	const insecureSkipVerifyRaw = pick("INSECURE_SKIP_VERIFY");
	const insecureSkipVerify = isTruthyFlag(insecureSkipVerifyRaw);

	const anySet =
		caCertPath !== undefined ||
		clientCertPath !== undefined ||
		clientKeyPath !== undefined ||
		serverNameOverride !== undefined ||
		insecureSkipVerify;

	if (!anySet) return undefined;

	return {
		caCertPath,
		clientCertPath,
		clientKeyPath,
		serverNameOverride,
		insecureSkipVerify,
	};
}

/**
 * Whether `BLOK_GRPC_REQUIRE_TLS=true` enforces TLS on non-loopback hosts.
 * When true, building a gRPC adapter with no TLS config against a non-loopback
 * host throws at startup. Loopback (localhost, 127.0.0.0/8, ::1) is exempted.
 */
export function isStrictTlsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyFlag(env.BLOK_GRPC_REQUIRE_TLS);
}

/**
 * Returns true when the host is a loopback address that doesn't require
 * TLS even under strict mode. Match is intentionally generous — covers
 * `localhost`, the 127.x range, IPv6 loopback, and the wildcard 0.0.0.0
 * (which dev SDKs commonly bind to).
 */
export function isLoopbackHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	if (normalized === "localhost" || normalized === "::1" || normalized === "0.0.0.0") return true;
	if (normalized.startsWith("127.")) return true;
	return false;
}

function isTruthyFlag(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
