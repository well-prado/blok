import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineNode } from "../defineNode";
import { normalizeWorkflow } from "../workflow/WorkflowNormalizer";

const manifest = {
	version: "1",
	classification: "agent-compatible",
	effects: ["read"],
	capabilities: ["workspace.read"],
	secrets: [],
	determinism: "deterministic",
	idempotency: "idempotent",
	maturity: "stable",
} as const;

describe("capability manifest authoring surfaces", () => {
	it("normalizes a defineNode manifest while leaving it optional", () => {
		const declared = defineNode({
			name: "declared",
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			capabilityManifest: { ...manifest, effects: ["read", "read"] },
			execute: async () => ({ ok: true }),
		});
		const legacy = defineNode({
			name: "legacy",
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			execute: async () => ({ ok: true }),
		});

		expect(declared.capabilityManifest?.effects).toEqual(["read"]);
		expect(legacy.capabilityManifest).toBeUndefined();
	});

	it("rejects invalid node metadata at definition time", () => {
		expect(() =>
			defineNode({
				name: "invalid",
				input: z.object({}),
				output: z.object({}),
				capabilityManifest: { ...manifest, version: "2" as "1" },
				execute: async () => ({}),
			}),
		).toThrow("version must be 1");
	});

	it("carries valid workflow metadata and rejects invalid metadata at load time", () => {
		const workflow = {
			name: "manifest-workflow",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/manifest" } },
			steps: [],
		};
		expect(normalizeWorkflow({ ...workflow, capabilityManifest: manifest }).capabilityManifest).toEqual(manifest);
		expect(() =>
			normalizeWorkflow({ ...workflow, capabilityManifest: { ...manifest, secrets: ["raw=value"] } }),
		).toThrow("secrets[0]");
	});
});
