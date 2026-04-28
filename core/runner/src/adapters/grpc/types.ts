import type { RuntimeKind } from "../RuntimeAdapter";

/**
 * Selectable transport between the runner and an SDK runtime.
 *
 * - `http` — legacy `HttpRuntimeAdapter` (POST /execute over JSON+HTTP/1).
 * - `grpc` — `GrpcRuntimeAdapter` (NodeRuntime/Execute over HTTP/2 + protobuf).
 */
export type Transport = "http" | "grpc";

/**
 * Configuration for a {@link GrpcRuntimeAdapter} instance.
 *
 * Fully `readonly` — adapters never mutate their config after construction.
 */
export interface GrpcAdapterConfig {
	readonly kind: RuntimeKind;
	readonly host: string;
	readonly port: number;
	readonly defaultDeadlineMs: number;
	readonly maxMessageBytes: number;
	readonly keepalive: KeepaliveConfig;
	readonly tls?: TlsConfig;
	/** Optional gRPC service config JSON for retries on the Health RPC. */
	readonly serviceConfigJson?: string;
	/**
	 * Background health-check polling interval in ms. Set to `0` to disable
	 * (useful in tests so timers don't leak). Defaults to
	 * {@link GRPC_DEFAULTS.HEALTH_INTERVAL_MS}.
	 */
	readonly healthCheckIntervalMs?: number;
	/**
	 * Number of consecutive Health/Check failures that opens the circuit
	 * (subsequent `execute()` / `executeStream()` calls fail fast with a
	 * `BlokError(category=DEPENDENCY)` instead of dialing). Defaults to
	 * {@link GRPC_DEFAULTS.HEALTH_FAILURE_THRESHOLD}.
	 */
	readonly healthCheckFailureThreshold?: number;
}

/**
 * Keepalive ping configuration. gRPC sends periodic HTTP/2 PING frames so
 * idle connections don't drop and so connection failures surface within
 * `timeoutMs` instead of after the OS TCP timeout (~minutes).
 */
export interface KeepaliveConfig {
	/** Interval between keepalive pings in ms. */
	readonly timeMs: number;
	/** Wait for ping ack within this many ms before considering the connection dead. */
	readonly timeoutMs: number;
	/** Send keepalives even when no calls are in flight. */
	readonly permitWithoutCalls: boolean;
}

/**
 * TLS / mTLS configuration. When omitted, the channel is plaintext (loopback
 * only — `BLOK_GRPC_REQUIRE_TLS=true` enforces TLS for non-loopback).
 */
export interface TlsConfig {
	/** Path to a CA certificate (PEM) for verifying the server. */
	readonly caCertPath?: string;
	/** Path to a client certificate (PEM) for mTLS. */
	readonly clientCertPath?: string;
	/** Path to a client private key (PEM) for mTLS. */
	readonly clientKeyPath?: string;
	/** Override the SNI hostname sent during TLS handshake. */
	readonly serverNameOverride?: string;
	/**
	 * Skip server certificate verification. **Development only** — adapters
	 * log a warning at startup when this is true.
	 */
	readonly insecureSkipVerify?: boolean;
}

/**
 * Default values for gRPC channel options.
 *
 * Single source of truth — referenced from {@link loadGrpcConfigFromEnv} and
 * the channel-options module. No magic numbers anywhere else.
 */
export const GRPC_DEFAULTS = {
	/** Default per-call deadline (matches today's HTTP `AbortSignal.timeout(30000)`). */
	DEFAULT_DEADLINE_MS: 30_000,
	/** Default 16MB max message size (matches the PHP `RequestBodyBuffer` ceiling from FIXES.md #5). */
	MAX_MESSAGE_BYTES: 16 * 1024 * 1024,
	/** Default keepalive ping interval. */
	KEEPALIVE_TIME_MS: 10_000,
	/** Default keepalive ack timeout. */
	KEEPALIVE_TIMEOUT_MS: 5_000,
	/** Send keepalives even with no in-flight calls — keeps connections warm. */
	KEEPALIVE_PERMIT_WITHOUT_CALLS: true,
	/** Health probe interval. */
	HEALTH_INTERVAL_MS: 30_000,
	/** Consecutive Health failures that trip the circuit breaker. */
	HEALTH_FAILURE_THRESHOLD: 3,
} as const;

/**
 * Default port mapping per language. We use `HTTP_PORT + 1000` for symmetry
 * with the existing HTTP ports (9001–9007 → 10001–10007). Operators can
 * override per language via `RUNTIME_<KIND>_GRPC_PORT`.
 */
export const DEFAULT_GRPC_PORTS: Readonly<Record<RuntimeKind, number>> = {
	nodejs: 0, // in-process; no port
	bun: 0,
	go: 10001,
	rust: 10002,
	java: 10003,
	csharp: 10004,
	php: 10005,
	ruby: 10006,
	python3: 10007,
	docker: 0,
	wasm: 0,
};
