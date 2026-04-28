import { describe, expect, it } from "vitest";
import { DEFAULT_HEALTH_SERVICE_CONFIG, buildChannelOptions } from "../../../../src/adapters/grpc/GrpcChannelOptions";
import { GRPC_DEFAULTS, type GrpcAdapterConfig } from "../../../../src/adapters/grpc/types";

function baseConfig(overrides: Partial<GrpcAdapterConfig> = {}): GrpcAdapterConfig {
	return {
		kind: "python3",
		host: "localhost",
		port: 10007,
		defaultDeadlineMs: GRPC_DEFAULTS.DEFAULT_DEADLINE_MS,
		maxMessageBytes: GRPC_DEFAULTS.MAX_MESSAGE_BYTES,
		keepalive: {
			timeMs: GRPC_DEFAULTS.KEEPALIVE_TIME_MS,
			timeoutMs: GRPC_DEFAULTS.KEEPALIVE_TIMEOUT_MS,
			permitWithoutCalls: GRPC_DEFAULTS.KEEPALIVE_PERMIT_WITHOUT_CALLS,
		},
		...overrides,
	};
}

describe("buildChannelOptions", () => {
	it("sets max send/receive message length to maxMessageBytes", () => {
		const opts = buildChannelOptions(baseConfig());
		expect(opts["grpc.max_send_message_length"]).toBe(GRPC_DEFAULTS.MAX_MESSAGE_BYTES);
		expect(opts["grpc.max_receive_message_length"]).toBe(GRPC_DEFAULTS.MAX_MESSAGE_BYTES);
	});

	it("uses the keepalive config", () => {
		const opts = buildChannelOptions(
			baseConfig({
				keepalive: { timeMs: 5000, timeoutMs: 2000, permitWithoutCalls: false },
			}),
		);
		expect(opts["grpc.keepalive_time_ms"]).toBe(5000);
		expect(opts["grpc.keepalive_timeout_ms"]).toBe(2000);
		expect(opts["grpc.keepalive_permit_without_calls"]).toBe(0);
		expect(opts["grpc.http2.min_time_between_pings_ms"]).toBe(5000);
	});

	it("encodes keepalive_permit_without_calls=true as 1", () => {
		const opts = buildChannelOptions(baseConfig());
		expect(opts["grpc.keepalive_permit_without_calls"]).toBe(1);
	});

	it("does not set ssl_target_name_override when no TLS config provided", () => {
		const opts = buildChannelOptions(baseConfig());
		expect(opts["grpc.ssl_target_name_override"]).toBeUndefined();
		expect(opts["grpc.default_authority"]).toBeUndefined();
	});

	it("sets ssl_target_name_override and default_authority when TLS serverNameOverride is provided", () => {
		const opts = buildChannelOptions(
			baseConfig({
				tls: { serverNameOverride: "blok-python3.svc.cluster.local" },
			}),
		);
		expect(opts["grpc.ssl_target_name_override"]).toBe("blok-python3.svc.cluster.local");
		expect(opts["grpc.default_authority"]).toBe("blok-python3.svc.cluster.local");
	});

	it("forwards serviceConfigJson when provided", () => {
		const customConfig = '{"loadBalancingPolicy":"round_robin"}';
		const opts = buildChannelOptions(baseConfig({ serviceConfigJson: customConfig }));
		expect(opts["grpc.service_config"]).toBe(customConfig);
	});
});

describe("DEFAULT_HEALTH_SERVICE_CONFIG", () => {
	it("permits retries on UNAVAILABLE for the Health RPC only", () => {
		const config = JSON.parse(DEFAULT_HEALTH_SERVICE_CONFIG) as {
			methodConfig: Array<{
				name: Array<{ service: string; method: string }>;
				retryPolicy: { retryableStatusCodes: string[]; maxAttempts: number };
			}>;
		};
		expect(config.methodConfig).toHaveLength(1);
		expect(config.methodConfig[0].name[0].service).toBe("blok.runtime.v1.NodeRuntime");
		expect(config.methodConfig[0].name[0].method).toBe("Health");
		expect(config.methodConfig[0].retryPolicy.retryableStatusCodes).toEqual(["UNAVAILABLE"]);
		expect(config.methodConfig[0].retryPolicy.maxAttempts).toBe(3);
	});

	it("does NOT include Execute (workflow steps are not retried automatically)", () => {
		const config = JSON.parse(DEFAULT_HEALTH_SERVICE_CONFIG) as {
			methodConfig: Array<{ name: Array<{ method: string }> }>;
		};
		const allMethods = config.methodConfig.flatMap((m) => m.name.map((n) => n.method));
		expect(allMethods).not.toContain("Execute");
		expect(allMethods).not.toContain("ExecuteStream");
	});
});

describe("GRPC_DEFAULTS", () => {
	it("matches values referenced from the saved migration plan", () => {
		expect(GRPC_DEFAULTS.DEFAULT_DEADLINE_MS).toBe(30_000);
		expect(GRPC_DEFAULTS.MAX_MESSAGE_BYTES).toBe(16 * 1024 * 1024);
		expect(GRPC_DEFAULTS.KEEPALIVE_TIME_MS).toBe(10_000);
		expect(GRPC_DEFAULTS.KEEPALIVE_TIMEOUT_MS).toBe(5_000);
		expect(GRPC_DEFAULTS.KEEPALIVE_PERMIT_WITHOUT_CALLS).toBe(true);
		expect(GRPC_DEFAULTS.HEALTH_INTERVAL_MS).toBe(30_000);
	});
});
