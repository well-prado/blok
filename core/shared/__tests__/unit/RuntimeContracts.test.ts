import { describe, expect, it } from "vitest";
import {
	JavaScriptRuntimeSchema,
	JavaScriptRuntimeSelectionSchema,
	RuntimeCapabilityManifestSchema,
	normalizeJavaScriptRuntime,
	normalizeRuntimeKind,
	runtimeKindForJavaScriptRuntime,
} from "../../src/RuntimeContracts";

describe("JavaScript runtime contract", () => {
	it("keeps project runtime and package manager as separate choices", () => {
		expect(JavaScriptRuntimeSelectionSchema.parse({ runtime: "deno", packageManager: "npm" })).toEqual({
			runtime: "deno",
			packageManager: "npm",
		});
		expect(JavaScriptRuntimeSchema.parse("node")).toBe("node");
	});

	it("normalizes legacy project aliases with an actionable diagnostic", () => {
		const normalized = normalizeJavaScriptRuntime("nodejs");

		expect(normalized.runtime).toBe("node");
		expect(normalized.diagnostic).toMatchObject({
			code: "deprecated-runtime-alias",
			input: "nodejs",
			canonical: "node",
		});
		expect(normalizeJavaScriptRuntime("bun")).toEqual({ runtime: "bun" });
	});

	it("maps project targets to canonical runner step kinds", () => {
		expect(runtimeKindForJavaScriptRuntime("node")).toBe("nodejs");
		expect(runtimeKindForJavaScriptRuntime("bun")).toBe("bun");
		expect(runtimeKindForJavaScriptRuntime("deno")).toBe("deno");
	});

	it("normalizes node aliases without changing the selected engine", () => {
		const normalized = normalizeRuntimeKind("node");

		expect(normalized.kind).toBe("nodejs");
		expect(normalized.diagnostic?.message).toContain('use "nodejs"');
		expect(normalizeRuntimeKind("deno")).toEqual({ kind: "deno" });
		expect(normalizeRuntimeKind("wasi")).toEqual({ kind: "wasi" });
	});

	it("validates the shared worker capability manifest shape", () => {
		const manifest = RuntimeCapabilityManifestSchema.parse({
			runtime: "deno",
			version: "2.0.0",
			protocolVersion: "1",
			moduleFormats: ["esm", "commonjs"],
			typescriptExecution: "native",
			npmCompatibility: "compatibility",
			permissions: {
				filesystem: "read",
				network: "restricted",
				environment: "declared",
				subprocess: "none",
				ffi: "none",
				secrets: "declared",
			},
			cancellation: true,
			streaming: true,
			maxMessageBytes: 16 * 1024 * 1024,
		});

		expect(manifest.runtime).toBe("deno");
	});
});
