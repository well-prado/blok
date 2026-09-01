import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	CapabilityManifestError,
	assessCapabilityManifest,
	parseCapabilityManifest,
	requireAgentEligibleManifest,
	serializeCapabilityManifest,
} from "../../src/CapabilityManifest";

interface ConformanceFixture {
	base: Record<string, unknown>;
	cases: Array<{ name: string; overrides: Record<string, unknown> }>;
	compatibilityCases: Array<{
		name: string;
		overrides: Record<string, unknown>;
		expectedStatus: "declared" | "invalid";
	}>;
}

function readConformanceFixture(): ConformanceFixture {
	return JSON.parse(
		readFileSync(
			new URL("../../../../tests/fixtures/capability-manifest/conformance-cases.v1.json", import.meta.url),
			"utf8",
		),
	) as ConformanceFixture;
}

const valid = {
	version: "1",
	classification: "agent-compatible",
	effects: ["network", "read", "network"],
	capabilities: ["network.http", "network.http"],
	secrets: ["github.token"],
	determinism: "external",
	idempotency: "idempotent",
	maturity: "stable",
	resources: { maxDurationMs: 5_000, maxOutputBytes: 1_048_576 },
	runtimes: ["python3", "nodejs"],
	triggers: ["worker", "http"],
	extraFromFutureVersion: { preservedOnWire: true },
} as const;

describe("capability manifest v1", () => {
	it("accepts every canonical effect/resource conformance case", () => {
		const fixture = readConformanceFixture();
		for (const testCase of fixture.cases) {
			expect(() => parseCapabilityManifest({ ...fixture.base, ...testCase.overrides }), testCase.name).not.toThrow();
		}
	});

	it("applies the fixture's invalid and forward-compatible parsing policy", () => {
		const fixture = readConformanceFixture();
		for (const testCase of fixture.compatibilityCases) {
			expect(assessCapabilityManifest({ ...fixture.base, ...testCase.overrides }).status, testCase.name).toBe(
				testCase.expectedStatus,
			);
		}
	});

	it("normalizes order/duplicates and ignores additive unknown fields", () => {
		expect(parseCapabilityManifest(valid)).toEqual({
			version: "1",
			classification: "agent-compatible",
			effects: ["network", "read"],
			capabilities: ["network.http"],
			secrets: ["github.token"],
			determinism: "external",
			idempotency: "idempotent",
			maturity: "stable",
			resources: { maxDurationMs: 5_000, maxOutputBytes: 1_048_576 },
			runtimes: ["nodejs", "python3"],
			triggers: ["http", "worker"],
		});
	});

	it("serializes deterministically", () => {
		expect(serializeCapabilityManifest(valid)).toBe(serializeCapabilityManifest({ ...valid }));
	});

	it.each([
		["missing", undefined, "missing-manifest"],
		["invalid", { ...valid, version: "2" }, "invalid-manifest"],
		["invalid", { ...valid, secrets: ["raw=value"] }, "invalid-manifest"],
	] as const)("marks %s metadata agent-ineligible", (_label, manifest, reason) => {
		expect(assessCapabilityManifest(manifest)).toMatchObject({ agentEligible: false, reason });
	});

	it.each(["trusted-legacy", "denied-to-agents"] as const)("keeps %s explicitly agent-ineligible", (classification) => {
		expect(assessCapabilityManifest({ ...valid, classification })).toMatchObject({
			status: "declared",
			agentEligible: false,
			reason: classification,
		});
	});

	it("fails closed at the agent boundary while accepting a valid agent manifest", () => {
		expect(requireAgentEligibleManifest(valid).classification).toBe("agent-compatible");
		expect(() => requireAgentEligibleManifest(undefined)).toThrow(CapabilityManifestError);
		expect(() => requireAgentEligibleManifest({ ...valid, classification: "trusted-legacy" })).toThrow(
			"trusted-legacy",
		);
	});

	it("rejects non-positive resource bounds and unknown effect values", () => {
		expect(() => parseCapabilityManifest({ ...valid, resources: { maxDurationMs: 0 } })).toThrow(
			"resources.maxDurationMs",
		);
		expect(() => parseCapabilityManifest({ ...valid, effects: ["telepathy"] })).toThrow("effects[0]");
	});
});
