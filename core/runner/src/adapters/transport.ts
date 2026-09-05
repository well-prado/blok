import type { Context, ResponseContext, VarsContext } from "@blokjs/shared";
import type { RuntimeKind } from "./RuntimeAdapter";
import type { TlsConfig } from "./grpc/types";

const SUPPORTED_KINDS: readonly RuntimeKind[] = ["go", "rust", "java", "csharp", "php", "ruby", "python3", "dart"];

/**
 * Reject any leftover `RUNTIME_TRANSPORT=http` (global) or
 * `RUNTIME_<KIND>_TRANSPORT=http` (per-kind) at startup. gRPC has been the
 * sole runtime transport since v0.5; the HTTP adapter and its env-var
 * escape hatch were removed at the same time. Silent fallback would mask
 * stale operator config, so we throw with the exact env-var the operator
 * still has set and a one-line migration hint.
 *
 * Throws on first offending env var found (the order is global first,
 * then per-kind so operators see the broadest mistake first).
 */
export function assertGrpcOnlyTransport(env: NodeJS.ProcessEnv = process.env): void {
	const global = env.RUNTIME_TRANSPORT;
	if (global !== undefined && global !== "" && global !== "grpc") {
		throw new Error(
			`[blok] RUNTIME_TRANSPORT=${global} is no longer supported (HttpRuntimeAdapter was removed in v0.5). Drop the env var; gRPC is the only runtime transport. SDK processes should boot with BLOK_TRANSPORT=grpc.`,
		);
	}
	for (const kind of SUPPORTED_KINDS) {
		const key = `RUNTIME_${kind.toUpperCase()}_TRANSPORT`;
		const value = env[key];
		if (value !== undefined && value !== "" && value !== "grpc") {
			throw new Error(
				`[blok] ${key}=${value} is no longer supported (HttpRuntimeAdapter was removed in v0.5). Drop the env var; gRPC is the only runtime transport.`,
			);
		}
	}
}

/**
 * Whether log streaming is enabled for runtime nodes. When true, the runner
 * routes runtime nodes through `GrpcRuntimeAdapter.executeStream` instead of
 * the unary `execute`, and `LogLine` frames flow into `RunTracker.addLog`
 * — surfacing live in Studio's `/__blok/runs/:id/stream` SSE endpoint.
 *
 * Streaming is a pure additive capability: when the env var is unset, the
 * legacy unary path runs unchanged. When enabled but the adapter doesn't
 * support streaming, `RuntimeAdapterNode` falls back to unary so
 * misconfiguration never blocks execution.
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
 * Hard ceiling for the configurable gRPC max message size. Well under
 * protobuf's 2 GiB serialized-message limit; bounds per-call memory
 * amplification (large unary messages are fully buffered on both ends, so peak
 * ≈ `forEach`-concurrency × this value).
 */
export const MAX_MESSAGE_BYTES_CEILING = 256 * 1024 * 1024;

/**
 * Resolve the gRPC max message size (bytes) from the environment.
 *
 * `BLOK_GRPC_MAX_MESSAGE_BYTES` overrides the default
 * ({@link GRPC_DEFAULTS.MAX_MESSAGE_BYTES}, 16 MB). Applied **symmetrically**
 * to send + receive on the channel. Must be a positive integer; values above
 * {@link MAX_MESSAGE_BYTES_CEILING} are clamped (with a warning). Unset /
 * non-numeric / ≤ 0 → `undefined` (the adapter uses the 16 MB default).
 *
 * ⚠️ The limit MUST match the server SDKs' limit — the Python (`bin/serve.py`)
 * and Rust (`config.rs`) sidecars read the SAME env var. A client-only raise
 * leaves the under-configured server rejecting oversized messages with
 * `RESOURCE_EXHAUSTED`. For genuinely bulk data, prefer the claim-check
 * pattern (write to an object store, pass a handle) over inlining bytes.
 */
export function resolveMaxMessageBytes(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env.BLOK_GRPC_MAX_MESSAGE_BYTES;
	if (raw === undefined || raw === "") return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed <= 0) return undefined;
	if (parsed > MAX_MESSAGE_BYTES_CEILING) {
		console.warn(
			`[blok][grpc] BLOK_GRPC_MAX_MESSAGE_BYTES=${parsed} exceeds the ${MAX_MESSAGE_BYTES_CEILING}-byte ceiling; clamping. Large unary messages are fully buffered in memory on both ends — prefer the claim-check pattern for bulk data.`,
		);
		return MAX_MESSAGE_BYTES_CEILING;
	}
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

/**
 * Whether a remote runtime call OMITS the accumulated run state
 * (`ctx.vars` — an alias of `ctx.state`, so it holds EVERY completed step's
 * output) and the previous step's output.
 *
 * ON by default since #874. Shipping the state bag on every call made per-call
 * cost linear in the run's accumulated state, so a `runtime.*` node inside a
 * `forEach` cost O(n²) over the loop — and the failure mode is a slow crawl,
 * not an error, so nobody thinks to look for a flag. Mapped `inputs` are
 * unaffected (that is where a v2 node reads its data from), `env` and the
 * trigger body still ride along, and state still flows BACK via the response
 * `vars_delta`.
 *
 * `BLOK_RUNTIME_STATE_DIET=0` restores the pre-#874 full-state payload for a
 * v1 node that reads `ctx.vars` / `ctx.response.data` inside its own body.
 * That is a whole-process switch; the per-node fix is to map the value the
 * node needs into that step's `inputs`.
 *
 * `BLOK_GRPC_STATE_DIET` is the original, gRPC-specific spelling and still
 * works as an alias (#885 shipped it and the docs name it). The diet applies
 * to every remote runtime transport — Docker, WASM and Bun-subprocess ship
 * the same state bag (#895) — so the transport-neutral name is canonical and
 * wins when both are set.
 */
export function isStateDietEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.BLOK_RUNTIME_STATE_DIET ?? env.BLOK_GRPC_STATE_DIET;
	return !isFalsyFlag(raw);
}

/**
 * The `{ response, vars }` half of a remote runtime payload, with the state
 * diet applied. Docker, WASM and Bun-subprocess all inline these two fields
 * verbatim, which is the same unbounded O(n²) growth term #885 removed from
 * the gRPC codec: `ctx.vars` holds EVERY completed step's output, so a
 * `runtime.*` node inside a `forEach` re-serializes a payload that grows with
 * the loop.
 *
 * The keys are kept (an SDK decoding the envelope still finds them) but
 * emptied: `vars` becomes `{}` and the previous step's output becomes `null`,
 * matching {@link isStateDietEnabled}'s gRPC semantics exactly — one flag,
 * one meaning, whatever the transport.
 */
export function stateForRuntimePayload(
	ctx: Context,
	env: NodeJS.ProcessEnv = process.env,
): { response: ResponseContext; vars: VarsContext } {
	const response = ctx.response ?? ({ data: null, error: null } as ResponseContext);
	if (!isStateDietEnabled(env)) return { response, vars: ctx.vars ?? {} };
	return { response: { ...response, data: null }, vars: {} };
}

function isTruthyFlag(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isFalsyFlag(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}
