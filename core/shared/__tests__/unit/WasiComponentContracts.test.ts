import { describe, expect, it } from "vitest";
import {
	WASI_COMPONENT_CAPABILITIES,
	WasiComponentExecutionRequestSchema,
	WasiComponentExecutionResponseSchema,
	parseWasiComponentManifest,
	serializeWasiComponentManifest,
} from "../../src";

const manifest = {
	version: "1",
	runtime: "runtime.wasi",
	artifact: {
		uri: "./components/greet.wasm",
		digest: `sha256:${"a".repeat(64)}`,
		mediaType: "application/wasm-component",
	},
	world: { package: "blok:runtime", world: "blok-node", version: "1.0.0" },
	wasiVersion: "0.2",
	componentModelVersion: "0.2",
	exportName: "execute",
	node: { name: "typed-greet", tags: ["pure"] },
	capabilityManifest: {
		version: "1",
		classification: "agent-compatible",
		effects: [],
		capabilities: [],
		secrets: [],
		determinism: "deterministic",
		idempotency: "idempotent",
		maturity: "stable",
	},
	limits: { fuel: 100_000, maxDurationMs: 1_000, maxOutputBytes: 4_096 },
};

describe("WASI Component Model contracts", () => {
	it("accepts the pinned v1/WASI 0.2 manifest and normalizes capability lists", () => {
		const parsed = parseWasiComponentManifest({
			...manifest,
			capabilityManifest: { ...manifest.capabilityManifest, capabilities: ["wasi.log", "wasi.blob.read", "wasi.log"] },
		});

		expect(parsed.runtime).toBe("runtime.wasi");
		expect(parsed.artifact.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(parsed.capabilityManifest.capabilities).toEqual(["wasi.blob.read", "wasi.log"]);
		expect(JSON.parse(serializeWasiComponentManifest(parsed))).toEqual(parsed);
	});

	it.each([
		["wrong runtime identity", { runtime: "runtime.wasm" }],
		["mutable digest", { artifact: { ...manifest.artifact, digest: "sha256:latest" } }],
		["unsupported WASI version", { wasiVersion: "0.3" }],
	])("rejects %s", (_label, override) => {
		expect(() => parseWasiComponentManifest({ ...manifest, ...override })).toThrow();
	});

	it("requires response success and structured error to agree", () => {
		expect(() =>
			WasiComponentExecutionResponseSchema.parse({
				contractVersion: "1",
				success: false,
				output: null,
				logs: [],
			}),
		).toThrow();
	});

	it("keeps the execution seam typed without imposing a node-specific schema", () => {
		const request = WasiComponentExecutionRequestSchema.parse({
			contractVersion: "1",
			componentDigest: manifest.artifact.digest,
			exportName: manifest.exportName,
			input: { greeting: "hello" },
			request: { body: { id: 1 }, headers: {}, params: {}, query: {} },
			contentType: "application/json",
			deadlineMs: 1000,
		});

		expect(request.input).toEqual({ greeting: "hello" });
		expect(WASI_COMPONENT_CAPABILITIES).toContain("wasi.blob.read");
	});
});
