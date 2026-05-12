import { describe, expect, it } from "vitest";
import {
	assertGrpcOnlyTransport,
	isLoopbackHost,
	isStreamLogsEnabled,
	isStrictTlsEnabled,
	loadTlsConfigForKind,
	resolveHealthCheckFailureThreshold,
	resolveHealthCheckIntervalMs,
} from "../../../src/adapters/transport";

describe("assertGrpcOnlyTransport", () => {
	it("is a no-op when no transport env vars are set (gRPC is the sole transport since v0.5)", () => {
		expect(() => assertGrpcOnlyTransport({})).not.toThrow();
	});

	it("accepts an explicit RUNTIME_TRANSPORT=grpc", () => {
		expect(() => assertGrpcOnlyTransport({ RUNTIME_TRANSPORT: "grpc" })).not.toThrow();
	});

	it("accepts per-kind RUNTIME_<KIND>_TRANSPORT=grpc", () => {
		const kinds = ["go", "rust", "java", "csharp", "php", "ruby", "python3"] as const;
		for (const kind of kinds) {
			const env = { [`RUNTIME_${kind.toUpperCase()}_TRANSPORT`]: "grpc" } as NodeJS.ProcessEnv;
			expect(() => assertGrpcOnlyTransport(env)).not.toThrow();
		}
	});

	it("throws on RUNTIME_TRANSPORT=http with a migration hint", () => {
		expect(() => assertGrpcOnlyTransport({ RUNTIME_TRANSPORT: "http" })).toThrowError(
			/RUNTIME_TRANSPORT=http is no longer supported.*v0\.5/,
		);
	});

	it("throws on per-kind RUNTIME_<KIND>_TRANSPORT=http", () => {
		expect(() => assertGrpcOnlyTransport({ RUNTIME_GO_TRANSPORT: "http" })).toThrowError(
			/RUNTIME_GO_TRANSPORT=http is no longer supported/,
		);
	});

	it("throws on any non-grpc value (not just 'http')", () => {
		expect(() => assertGrpcOnlyTransport({ RUNTIME_TRANSPORT: "rest" })).toThrowError(/RUNTIME_TRANSPORT=rest/);
		expect(() => assertGrpcOnlyTransport({ RUNTIME_PYTHON3_TRANSPORT: "weird" })).toThrowError(
			/RUNTIME_PYTHON3_TRANSPORT=weird/,
		);
	});

	it("surfaces the global env var first when both global and per-kind are set", () => {
		expect(() =>
			assertGrpcOnlyTransport({
				RUNTIME_TRANSPORT: "http",
				RUNTIME_GO_TRANSPORT: "http",
			}),
		).toThrowError(/RUNTIME_TRANSPORT=http/);
	});
});

describe("isStreamLogsEnabled", () => {
	it("returns false when BLOK_STREAM_LOGS is unset", () => {
		expect(isStreamLogsEnabled({})).toBe(false);
	});

	it("returns true for truthy values (case-insensitive)", () => {
		for (const value of ["1", "true", "TRUE", "yes", "Yes", "on", "ON"]) {
			expect(isStreamLogsEnabled({ BLOK_STREAM_LOGS: value })).toBe(true);
		}
	});

	it("returns false for falsy values", () => {
		for (const value of ["0", "false", "no", "off", "", "  "]) {
			expect(isStreamLogsEnabled({ BLOK_STREAM_LOGS: value })).toBe(false);
		}
	});

	it("trims whitespace before evaluating the value", () => {
		expect(isStreamLogsEnabled({ BLOK_STREAM_LOGS: "  true  " })).toBe(true);
	});

	it("returns false for arbitrary non-truthy strings", () => {
		expect(isStreamLogsEnabled({ BLOK_STREAM_LOGS: "maybe" })).toBe(false);
	});
});

describe("resolveHealthCheckIntervalMs", () => {
	it("returns undefined when unset or empty", () => {
		expect(resolveHealthCheckIntervalMs({})).toBeUndefined();
		expect(resolveHealthCheckIntervalMs({ BLOK_GRPC_HEALTH_INTERVAL_MS: "" })).toBeUndefined();
	});

	it("returns the parsed integer when set", () => {
		expect(resolveHealthCheckIntervalMs({ BLOK_GRPC_HEALTH_INTERVAL_MS: "5000" })).toBe(5000);
		expect(resolveHealthCheckIntervalMs({ BLOK_GRPC_HEALTH_INTERVAL_MS: "0" })).toBe(0);
	});

	it("returns undefined for non-numeric or negative values (caller falls back to default)", () => {
		expect(resolveHealthCheckIntervalMs({ BLOK_GRPC_HEALTH_INTERVAL_MS: "fast" })).toBeUndefined();
		expect(resolveHealthCheckIntervalMs({ BLOK_GRPC_HEALTH_INTERVAL_MS: "-1" })).toBeUndefined();
	});
});

describe("resolveHealthCheckFailureThreshold", () => {
	it("returns undefined when unset or empty", () => {
		expect(resolveHealthCheckFailureThreshold({})).toBeUndefined();
		expect(resolveHealthCheckFailureThreshold({ BLOK_GRPC_HEALTH_FAILURE_THRESHOLD: "" })).toBeUndefined();
	});

	it("returns the parsed integer when ≥ 1", () => {
		expect(resolveHealthCheckFailureThreshold({ BLOK_GRPC_HEALTH_FAILURE_THRESHOLD: "5" })).toBe(5);
		expect(resolveHealthCheckFailureThreshold({ BLOK_GRPC_HEALTH_FAILURE_THRESHOLD: "1" })).toBe(1);
	});

	it("returns undefined for invalid values (the checker requires ≥ 1)", () => {
		expect(resolveHealthCheckFailureThreshold({ BLOK_GRPC_HEALTH_FAILURE_THRESHOLD: "0" })).toBeUndefined();
		expect(resolveHealthCheckFailureThreshold({ BLOK_GRPC_HEALTH_FAILURE_THRESHOLD: "-2" })).toBeUndefined();
		expect(resolveHealthCheckFailureThreshold({ BLOK_GRPC_HEALTH_FAILURE_THRESHOLD: "nope" })).toBeUndefined();
	});
});

describe("loadTlsConfigForKind", () => {
	it("returns undefined when no TLS env vars are set", () => {
		expect(loadTlsConfigForKind("python3", {})).toBeUndefined();
	});

	it("reads per-kind env vars first", () => {
		const tls = loadTlsConfigForKind("python3", {
			RUNTIME_PYTHON3_TLS_CA: "/etc/ssl/ca.pem",
			RUNTIME_PYTHON3_TLS_CLIENT_CERT: "/etc/ssl/client.crt",
			RUNTIME_PYTHON3_TLS_CLIENT_KEY: "/etc/ssl/client.key",
			RUNTIME_PYTHON3_TLS_SERVER_NAME: "py.internal",
		});

		expect(tls).toEqual({
			caCertPath: "/etc/ssl/ca.pem",
			clientCertPath: "/etc/ssl/client.crt",
			clientKeyPath: "/etc/ssl/client.key",
			serverNameOverride: "py.internal",
			insecureSkipVerify: false,
		});
	});

	it("falls back to BLOK_GRPC_TLS_* globals when per-kind vars are missing", () => {
		const tls = loadTlsConfigForKind("go", {
			BLOK_GRPC_TLS_CA: "/etc/ssl/global-ca.pem",
		});
		expect(tls).toEqual({
			caCertPath: "/etc/ssl/global-ca.pem",
			clientCertPath: undefined,
			clientKeyPath: undefined,
			serverNameOverride: undefined,
			insecureSkipVerify: false,
		});
	});

	it("per-kind overrides global", () => {
		const tls = loadTlsConfigForKind("rust", {
			BLOK_GRPC_TLS_CA: "/global/ca.pem",
			RUNTIME_RUST_TLS_CA: "/rust/ca.pem",
		});
		expect(tls?.caCertPath).toBe("/rust/ca.pem");
	});

	it("parses INSECURE_SKIP_VERIFY truthy values", () => {
		const tls = loadTlsConfigForKind("ruby", {
			RUNTIME_RUBY_TLS_INSECURE_SKIP_VERIFY: "true",
		});
		expect(tls?.insecureSkipVerify).toBe(true);
	});

	it("treats INSECURE_SKIP_VERIFY=false as a non-flag (no TLS config produced if nothing else set)", () => {
		const tls = loadTlsConfigForKind("ruby", {
			RUNTIME_RUBY_TLS_INSECURE_SKIP_VERIFY: "false",
		});
		expect(tls).toBeUndefined();
	});

	it("supports every standard runtime kind", () => {
		const kinds = ["go", "rust", "java", "csharp", "php", "ruby", "python3"] as const;
		for (const kind of kinds) {
			const env = { [`RUNTIME_${kind.toUpperCase()}_TLS_CA`]: "/path/ca.pem" };
			expect(loadTlsConfigForKind(kind, env)?.caCertPath).toBe("/path/ca.pem");
		}
	});
});

describe("isStrictTlsEnabled", () => {
	it("returns false when BLOK_GRPC_REQUIRE_TLS is unset", () => {
		expect(isStrictTlsEnabled({})).toBe(false);
	});

	it("returns true for truthy values", () => {
		for (const value of ["1", "true", "TRUE", "yes", "on"]) {
			expect(isStrictTlsEnabled({ BLOK_GRPC_REQUIRE_TLS: value })).toBe(true);
		}
	});

	it("returns false for explicit false-ish values", () => {
		for (const value of ["0", "false", "no", "off", ""]) {
			expect(isStrictTlsEnabled({ BLOK_GRPC_REQUIRE_TLS: value })).toBe(false);
		}
	});
});

describe("isLoopbackHost", () => {
	it("recognizes the canonical loopback names", () => {
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("LocalHost")).toBe(true);
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		expect(isLoopbackHost("127.10.20.30")).toBe(true);
		expect(isLoopbackHost("::1")).toBe(true);
		expect(isLoopbackHost("0.0.0.0")).toBe(true);
	});

	it("rejects non-loopback hosts", () => {
		expect(isLoopbackHost("10.0.0.5")).toBe(false);
		expect(isLoopbackHost("api.internal")).toBe(false);
		expect(isLoopbackHost("192.168.1.1")).toBe(false);
		expect(isLoopbackHost("8.8.8.8")).toBe(false);
	});
});
