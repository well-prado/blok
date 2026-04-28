import { describe, expect, it } from "vitest";
import { resolveTransportForKind } from "../../../src/adapters/transport";

describe("resolveTransportForKind", () => {
	it("returns http when no env vars are set", () => {
		expect(resolveTransportForKind("python3", {})).toBe("http");
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

	it("falls back to http when env values are invalid", () => {
		expect(resolveTransportForKind("python3", { RUNTIME_TRANSPORT: "weird" })).toBe("http");
		expect(resolveTransportForKind("python3", { RUNTIME_PYTHON3_TRANSPORT: "weird" })).toBe("http");
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
