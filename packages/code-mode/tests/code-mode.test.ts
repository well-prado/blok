import type { PolicyEvaluationResult, PolicyProvider } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	CodeModeBindingError,
	CodeModeBindingRegistry,
	createCodeModeCatalog,
	defineCapabilityBinding,
	defineWorkflowBinding,
	generateCodeModeBindings,
	serializeCodeModeDescriptor,
} from "../src";

const manifest = {
	version: "1" as const,
	classification: "agent-compatible" as const,
	effects: ["read"] as const,
	capabilities: ["workspace.read"],
	secrets: ["hidden.secret"],
	determinism: "external" as const,
	idempotency: "idempotent" as const,
	maturity: "stable" as const,
};

const identity = {
	principal: { id: "assistant", kind: "agent" },
	session: { id: "session-1" },
	turn: { id: "turn-1" },
	workflow: { name: "coding", version: "1" },
};

function allowPolicy(): PolicyProvider {
	return {
		evaluate: async (): Promise<PolicyEvaluationResult> => ({
			decision: { kind: "allow", id: "decision-1", reasonCode: "allowed", policyVersion: "policy-1" },
			matchedRules: [],
		}),
	};
}

function options(overrides: Partial<Parameters<typeof generateCodeModeBindings>[1]> = {}) {
	return {
		phase: "implementing" as const,
		identity,
		provider: allowPolicy(),
		policyVersion: "policy-1",
		handlers: {
			workflow: async (_input: unknown) => ({ content: "workflow" }),
			capability: async (input: unknown) => ({ content: (input as { path: string }).path }),
		},
		...overrides,
	};
}

const readFile = defineCapabilityBinding({
	id: "workspace/read-file",
	version: "1",
	description: "Read a workspace file.",
	input: z.object({ path: z.string().min(1) }),
	output: z.object({ content: z.string() }),
	outputKind: "object",
	capabilityManifest: manifest,
	invoke: async (input) => ({ content: input.path }),
});

const workflow = defineWorkflowBinding({
	id: "workflow/plan",
	version: "3",
	description: "Create a bounded implementation plan.",
	input: z.object({ task: z.string() }),
	output: z.object({ content: z.string() }),
	outputKind: "object",
	capabilityManifest: { ...manifest, capabilities: [], effects: [] },
	invoke: async (input) => ({ content: input.task }),
});

describe("@blokjs/code-mode", () => {
	it("derives typed definitions from Zod input/output schemas", async () => {
		const typed = defineCapabilityBinding({
			id: "typed",
			version: "1",
			description: "A typed binding.",
			input: z.object({ count: z.number() }),
			output: z.object({ doubled: z.number() }),
			outputKind: "object",
			capabilityManifest: { ...manifest, capabilities: [], effects: [] },
			invoke: (input) => ({ doubled: input.count * 2 }),
		});
		const catalog = createCodeModeCatalog("catalog-1", [typed]);
		const result = await generateCodeModeBindings(
			catalog,
			options({ handlers: { capability: async (input) => ({ doubled: (input as { count: number }).count * 2 }) } }),
		);
		expect(result.capabilities.capability_typed).toBeDefined();
		expect(result.surface.declarations).toContain('"count": number');
	});

	it("filters implementation-only, phase, maturity, and policy-denied bindings", async () => {
		const implementation = defineCapabilityBinding({
			...readFile.definition,
			id: "implementation",
			implementationOnly: true,
		});
		const planningOnly = defineCapabilityBinding({
			...readFile.definition,
			id: "planning-only",
			phases: ["planning"],
		});
		const denied = defineCapabilityBinding({ ...readFile.definition, id: "denied" });
		const provider: PolicyProvider = {
			evaluate: async (request) => ({
				decision: {
					kind: request.step.id.endsWith("denied") ? "deny" : "allow",
					id: `decision-${request.step.id}`,
					reasonCode: request.step.id.endsWith("denied") ? "forbidden" : "allowed",
					policyVersion: "policy-1",
				},
				matchedRules: [],
			}),
		};
		const result = await generateCodeModeBindings(
			createCodeModeCatalog("catalog-1", [readFile, implementation, planningOnly, denied]),
			options({ provider }),
		);
		expect(Object.keys(result.capabilities)).toEqual(["capability_workspace_read_file"]);
		expect(result.surface.unavailable.map((item) => item.reasonCode)).toContain("implementation-only");
		expect(result.surface.unavailable.map((item) => item.reasonCode)).toContain("phase-unavailable");
		expect(result.surface.unavailable.map((item) => item.reasonCode)).toContain("policy-denied");
	});

	it("revalidates input, policy, output, authority, and records non-secret provenance", async () => {
		let seenContext: Parameters<NonNullable<NonNullable<typeof readFile.definition.invoke>>>[1] | undefined;
		const provider: PolicyProvider = {
			evaluate: async (request) => {
				expect(request.manifest?.secrets).toEqual(["hidden.secret"]);
				expect(request.scope.capabilities).toEqual(["workspace.read"]);
				return {
					decision: { kind: "allow", id: "decision-runtime", reasonCode: "allowed", policyVersion: "policy-1" },
					matchedRules: [],
				};
			},
		};
		const registry = new CodeModeBindingRegistry(
			createCodeModeCatalog("catalog-1", [readFile]),
			options({
				provider,
				handlers: {
					capability: async (_input, context) => {
						seenContext = context;
						return { content: "ok" };
					},
				},
			}),
		);
		await expect(registry.invoke("capability_workspace_read_file", { path: "" })).rejects.toMatchObject({
			code: "INPUT_INVALID",
		});
		expect(await registry.invoke("capability_workspace_read_file", { path: "a.ts" })).toEqual({ content: "ok" });
		expect(seenContext?.provenance.capabilities).toEqual(["workspace.read"]);
		expect(JSON.stringify(seenContext?.provenance)).not.toContain("hidden.secret");
		const detailed = await registry.invokeWithProvenance("capability_workspace_read_file", { path: "a.ts" });
		expect(detailed.provenance.policyDecisionId).toBe("decision-runtime");
	});

	it("propagates only a narrowed authority and rejects policy widening", async () => {
		const provider: PolicyProvider = {
			evaluate: async () => ({
				decision: { kind: "allow", id: "decision-narrow", reasonCode: "allowed", policyVersion: "policy-1" },
				matchedRules: [],
				scope: {
					effects: ["read"],
					capabilities: ["workspace.read"],
					secrets: [],
					fragments: {},
				},
			}),
		};
		const registry = new CodeModeBindingRegistry(
			createCodeModeCatalog("catalog-1", [readFile]),
			options({
				provider,
				identity: {
					...identity,
					authority: {
						effects: ["read", "write"],
						capabilities: ["workspace.read", "workspace.write"],
						secrets: ["hidden.secret"],
						fragments: {},
					},
				},
			}),
		);
		const result = await registry.invokeWithProvenance("capability_workspace_read_file", { path: "a.ts" });
		expect(result.provenance.effects).toEqual(["read"]);
		expect(result.value).toEqual({ content: "a.ts" });
		const widening: PolicyProvider = {
			evaluate: async () => ({
				decision: { kind: "allow", id: "decision-widen", reasonCode: "allowed", policyVersion: "policy-1" },
				matchedRules: [],
				scope: {
					effects: ["write"],
					capabilities: ["workspace.write"],
					secrets: [],
					fragments: {},
				},
			}),
		};
		const widened = new CodeModeBindingRegistry(
			createCodeModeCatalog("catalog-1", [readFile]),
			options({ provider: widening }),
		);
		await expect(widened.invoke("capability_workspace_read_file", { path: "a.ts" })).rejects.toMatchObject({
			code: "POLICY_MALFORMED",
		});
	});

	it("rejects stale policy results and prevents implementation-only invocation", async () => {
		const staleProvider: PolicyProvider = {
			evaluate: async () => ({
				decision: { kind: "allow", id: "decision-old", reasonCode: "allowed", policyVersion: "old" },
				matchedRules: [],
			}),
		};
		const registry = new CodeModeBindingRegistry(
			createCodeModeCatalog("catalog-1", [workflow]),
			options({ provider: staleProvider }),
		);
		await expect(registry.invoke("workflow_workflow_plan", { task: "x" })).rejects.toMatchObject({
			code: "POLICY_STALE",
		});
	});

	it("uses deterministic collision-safe names and descriptor serialization", () => {
		const left = defineCapabilityBinding({ ...readFile.definition, id: "foo-bar" });
		const right = defineCapabilityBinding({ ...readFile.definition, id: "foo_bar" });
		const catalog = createCodeModeCatalog("catalog-1", [right, left]);
		const registry = new CodeModeBindingRegistry(catalog, options());
		return registry.generate().then((result) => {
			const names = Object.keys(result.capabilities);
			expect(names).toHaveLength(2);
			expect(new Set(names).size).toBe(2);
			expect(names[1]).toMatch(/^capability_foo_bar__/);
			expect(serializeCodeModeDescriptor(left.descriptor)).toBe(serializeCodeModeDescriptor({ ...left.descriptor }));
		});
	});

	it("returns stable errors for policy denial and output contract violations", async () => {
		const denied: PolicyProvider = {
			evaluate: async () => ({
				decision: { kind: "deny", id: "decision-denied", reasonCode: "forbidden", policyVersion: "policy-1" },
				matchedRules: [],
			}),
		};
		const registry = new CodeModeBindingRegistry(
			createCodeModeCatalog("catalog-1", [readFile]),
			options({ provider: denied }),
		);
		await expect(registry.invoke("capability_workspace_read_file", { path: "a.ts" })).rejects.toMatchObject({
			code: "POLICY_DENIED",
		});
		const broken = defineCapabilityBinding({
			...readFile.definition,
			id: "broken",
			outputKind: "artifact-reference",
			output: z.object({ content: z.string() }),
		});
		const brokenRegistry = new CodeModeBindingRegistry(
			createCodeModeCatalog("catalog-1", [broken]),
			options({ handlers: { capability: async () => ({ content: "not-an-artifact" }) } }),
		);
		await expect(brokenRegistry.invoke("capability_broken", { path: "a.ts" })).rejects.toMatchObject({
			code: "OUTPUT_KIND_MISMATCH",
		});
	});
});
