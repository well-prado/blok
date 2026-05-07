import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetHttpDeprecationCache,
	isLoopbackHost,
	isStreamLogsEnabled,
	isStrictTlsEnabled,
	loadTlsConfigForKind,
	resolveHealthCheckFailureThreshold,
	resolveHealthCheckIntervalMs,
	resolveTransportForKind,
} from "../../../src/adapters/transport";

describe("resolveTransportForKind", () => {
	it("returns the Phase 6 default (grpc) when no env vars are set", () => {
		// Master plan §11/§14 Phase 6 flip: the hard-coded default went
		// from `http` to `grpc` once the parity matrix had been green
		// for the observation window. HTTP remains opt-in via env.
		expect(resolveTransportForKind("python3", {})).toBe("grpc");
	});

	it("returns the global default when set", () => {
		expect(resolveTransportForKind("python3", { RUNTIME_TRANSPORT: "grpc" })).toBe("grpc");
		expect(resolveTransportForKind("python3", { RUNTIME_TRANSPORT: "http" })).toBe("http");
	});

	it("per-kind override takes precedence over global", () => {
		expect(
			resolveTransportForKind("python3", {
				RUNTIME_TRANSPORT: "http",
				RUNTIME_PYTHON3_TRANSPORT: "grpc",
			}),
		).toBe("grpc");

		expect(
			resolveTransportForKind("go", {
				RUNTIME_TRANSPORT: "grpc",
				RUNTIME_GO_TRANSPORT: "http",
			}),
		).toBe("http");
	});

	it("falls back to the Phase 6 default (grpc) when env values are invalid", () => {
		expect(resolveTransportForKind("python3", { RUNTIME_TRANSPORT: "weird" })).toBe("grpc");
		expect(resolveTransportForKind("python3", { RUNTIME_PYTHON3_TRANSPORT: "weird" })).toBe("grpc");
	});

	it("uppercases the kind correctly for the env var key", () => {
		expect(
			resolveTransportForKind("csharp", {
				RUNTIME_CSHARP_TRANSPORT: "grpc",
			}),
		).toBe("grpc");
	});

	it("supports every standard runtime kind via per-kind override", () => {
		const kinds = ["go", "rust", "java", "csharp", "php", "ruby", "python3"] as const;
		for (const kind of kinds) {
			const env = { [`RUNTIME_${kind.toUpperCase()}_TRANSPORT`]: "grpc" };
			expect(resolveTransportForKind(kind, env)).toBe("grpc");
		}
	});
});

describe("resolveTransportForKind — HTTP deprecation warning", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		_resetHttpDeprecationCache();
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it("warns once when RUNTIME_TRANSPORT=http resolves", () => {
		expect(resolveTransportForKind("python3", { RUNTIME_TRANSPORT: "http" })).toBe("http");
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][0]).toContain("RUNTIME_TRANSPORT=http is deprecated");
		expect(warnSpy.mock.calls[0][0]).toContain("v0.4.0");
	});

	it("warns once when RUNTIME_<KIND>_TRANSPORT=http resolves", () => {
		expect(resolveTransportForKind("go", { RUNTIME_GO_TRANSPORT: "http" })).toBe("http");
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][0]).toContain("RUNTIME_GO_TRANSPORT=http");
	});

	it("dedupes warnings per env var key across multiple resolves", () => {
		resolveTransportForKind("python3", { RUNTIME_TRANSPORT: "http" });
		resolveTransportForKind("go", { RUNTIME_TRANSPORT: "http" });
		resolveTransportForKind("rust", { RUNTIME_TRANSPORT: "http" });
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	it("warns separately for the global override and a per-kind override", () => {
		resolveTransportForKind("python3", { RUNTIME_TRANSPORT: "http" });
		resolveTransportForKind("go", { RUNTIME_GO_TRANSPORT: "http" });
		expect(warnSpy).toHaveBeenCalledTimes(2);
	});

	it("does NOT warn when transport resolves to grpc (default or explicit)", () => {
		resolveTransportForKind("python3", {});
		resolveTransportForKind("python3", { RUNTIME_TRANSPORT: "grpc" });
		resolveTransportForKind("go", { RUNTIME_GO_TRANSPORT: "grpc" });
		expect(warnSpy).not.toHaveBeenCalled();
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
