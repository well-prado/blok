import type { ChannelOptions } from "@grpc/grpc-js";
import { GRPC_DEFAULTS, type GrpcAdapterConfig } from "./types";

/**
 * Build the {@link ChannelOptions} dictionary for `@grpc/grpc-js` from a
 * {@link GrpcAdapterConfig}. Pure function — no I/O.
 *
 * The returned options enforce:
 * - 16MB max send/receive message length (parity with PHP buffer ceiling).
 * - Keepalive pings every 10s with 5s ack timeout.
 * - TLS server-name override when provided.
 *
 * Service config (for `Health` RPC retries) is passed through verbatim so
 * advanced users can tune retry/hedging policy without touching this file.
 *
 * @example
 *   const channel = new grpc.Client(
 *     `${cfg.host}:${cfg.port}`,
 *     credentials,
 *     buildChannelOptions(cfg),
 *   );
 */
export function buildChannelOptions(config: GrpcAdapterConfig): ChannelOptions {
	const opts: ChannelOptions = {
		"grpc.max_send_message_length": config.maxMessageBytes,
		"grpc.max_receive_message_length": config.maxMessageBytes,
		"grpc.keepalive_time_ms": config.keepalive.timeMs,
		"grpc.keepalive_timeout_ms": config.keepalive.timeoutMs,
		"grpc.keepalive_permit_without_calls": config.keepalive.permitWithoutCalls ? 1 : 0,
		// Sets the maximum amount of time a connection can be idle before keepalive
		// pings start. Matches keepalive_time so we ping consistently.
		"grpc.http2.min_time_between_pings_ms": config.keepalive.timeMs,
	};

	if (config.tls?.serverNameOverride) {
		opts["grpc.ssl_target_name_override"] = config.tls.serverNameOverride;
		opts["grpc.default_authority"] = config.tls.serverNameOverride;
	}

	if (config.serviceConfigJson) {
		opts["grpc.service_config"] = config.serviceConfigJson;
	}

	return opts;
}

/**
 * Default service config for the Health RPC. Permits up to 3 retries on
 * `UNAVAILABLE` with exponential backoff.
 *
 * Only applied to `NodeRuntime/Health` — `Execute` is intentionally never
 * retried automatically because workflow steps are not idempotent in general.
 */
export const DEFAULT_HEALTH_SERVICE_CONFIG: string = JSON.stringify({
	methodConfig: [
		{
			name: [
				{
					service: "blok.runtime.v1.NodeRuntime",
					method: "Health",
				},
			],
			retryPolicy: {
				maxAttempts: 3,
				initialBackoff: "0.1s",
				maxBackoff: "1s",
				backoffMultiplier: 2,
				retryableStatusCodes: ["UNAVAILABLE"],
			},
		},
	],
});

export { GRPC_DEFAULTS };
