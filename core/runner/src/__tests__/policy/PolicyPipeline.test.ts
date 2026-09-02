import type { Context, PolicyRequest } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import Runner from "../../Runner";
import { defineNode } from "../../defineNode";
import { DurableInteractionPort, InMemoryInteractionStore } from "../../policy/InteractionStore";
import {
	InMemoryAuditSink,
	InMemoryPolicyProvider,
	PolicyDeniedError,
	PolicyInteractionRequiredError,
	installPolicyExecution,
	reauthorizePolicyRequest,
	validateChildPolicyAuthority,
} from "../../policy/PolicyPipeline";

const manifest = {
	version: "1" as const,
	classification: "agent-compatible" as const,
	effects: ["network"] as const,
	capabilities: ["network.test"] as const,
	secrets: [] as const,
	determinism: "external" as const,
	idempotency: "idempotent" as const,
	maturity: "stable" as const,
};

function context(nodeName: string, input: unknown): Context {
	return {
		id: "run-1",
		workflow_name: "policy-test",
		workflow_path: "<test>",
		request: { body: {}, headers: {}, params: {}, query: {} },
		response: { success: true, data: null, error: null },
		error: { message: [] },
		logger: { log: () => undefined } as Context["logger"],
		config: { [nodeName]: { inputs: input } },
		eventLogger: null,
		state: {},
		vars: {},
		_PRIVATE_: {},
	} as Context;
}

function policy(allow: boolean, auditSink: InMemoryAuditSink) {
	return {
		principal: { id: "principal-1", kind: "test" },
		session: { id: "session-1" },
		turn: { id: "turn-1" },
		policyVersion: "test-v1",
		provider: new InMemoryPolicyProvider(async () => ({
			decision: {
				kind: allow ? "allow" : "deny",
				id: "decision-1",
				reasonCode: allow ? "allowed" : "blocked",
				policyVersion: "test-v1",
			},
			matchedRules: [{ layer: "deployment" as const, ruleId: allow ? "allow-test" : "deny-test" }],
		})),
		auditSink,
	};
}

describe("runner policy boundary", () => {
	it("narrows leaf requests by parent and active policy authority", async () => {
		const node = defineNode({
			name: "effect",
			input: z.object({ value: z.string() }),
			output: z.object({ ok: z.boolean() }),
			capabilityManifest: {
				...manifest,
				effects: ["network", "read"],
				capabilities: ["network.test", "workspace.read"],
			},
			execute: async () => ({ ok: true }),
		});
		const seen: PolicyRequest[] = [];
		const audit = new InMemoryAuditSink();
		const ctx = context("effect", { value: "x" });
		installPolicyExecution(ctx, {
			...policy(true, audit),
			authority: {
				effects: ["read", "network"],
				capabilities: ["network.test"],
				secrets: [],
				fragments: {},
			},
			provider: new InMemoryPolicyProvider(async (request) => {
				seen.push(request);
				return {
					decision: { kind: "allow", id: "decision-1", reasonCode: "allowed", policyVersion: "test-v1" },
					matchedRules: [],
					scope: { effects: ["network"], capabilities: ["network.test"], secrets: [], fragments: {} },
				};
			}),
		});

		await new Runner([node]).run(ctx);
		expect(seen[0]?.scope).toEqual({
			effects: ["network", "read"],
			capabilities: ["network.test"],
			secrets: [],
			fragments: {},
		});
		expect(audit.read()[0]?.scope).toEqual({
			effects: ["network"],
			capabilities: ["network.test"],
			secrets: [],
			fragments: {},
		});
	});

	it("validates a child authority before it can be propagated", () => {
		const ctx = context("effect", { value: "x" });
		installPolicyExecution(ctx, {
			...policy(true, new InMemoryAuditSink()),
			authority: {
				effects: ["read"],
				capabilities: ["workspace.read"],
				secrets: [],
				fragments: {},
			},
		});

		expect(() =>
			validateChildPolicyAuthority(ctx, {
				effects: ["write"],
				capabilities: ["workspace.write"],
				secrets: [],
				fragments: {},
			}),
		).toThrow(/child authority\.effects contains unauthorized value\(s\): write/);
		expect(
			validateChildPolicyAuthority(ctx, {
				effects: ["read"],
				capabilities: ["workspace.read"],
				secrets: [],
				fragments: {},
			}),
		).toEqual({ effects: ["read"], capabilities: ["workspace.read"], secrets: [], fragments: {} });
	});

	it("prepares, authorizes, and executes an agent node once", async () => {
		let calls = 0;
		const node = defineNode({
			name: "effect",
			input: z.object({ value: z.string() }),
			output: z.object({ ok: z.boolean() }),
			capabilityManifest: manifest,
			execute: async () => {
				calls += 1;
				return { ok: true };
			},
		});
		const ctx = context("effect", { value: "x" });
		const audit = new InMemoryAuditSink();
		installPolicyExecution(ctx, policy(true, audit));
		await new Runner([node]).run(ctx);
		expect(calls).toBe(1);
		expect(audit.read().map((event) => event.eventType)).toEqual(["policy.pre", "policy.post"]);
	});

	it("denies before the node executes", async () => {
		let calls = 0;
		const node = defineNode({
			name: "effect",
			input: z.object({ value: z.string() }),
			output: z.object({ ok: z.boolean() }),
			capabilityManifest: manifest,
			execute: async () => {
				calls += 1;
				return { ok: true };
			},
		});
		const ctx = context("effect", { value: "x" });
		installPolicyExecution(ctx, policy(false, new InMemoryAuditSink()));
		await expect(new Runner([node]).run(ctx)).rejects.toBeInstanceOf(PolicyDeniedError);
		expect(calls).toBe(0);
	});

	it("persists an ask before the typed control signal escapes", async () => {
		let calls = 0;
		const node = defineNode({
			name: "effect",
			input: z.object({ value: z.string() }),
			output: z.object({ ok: z.boolean() }),
			capabilityManifest: manifest,
			execute: async () => {
				calls += 1;
				return { ok: true };
			},
		});
		const ctx = context("effect", { value: "x" });
		const audit = new InMemoryAuditSink();
		const store = new InMemoryInteractionStore();
		installPolicyExecution(ctx, {
			...policy(true, audit),
			provider: new InMemoryPolicyProvider(async () => ({
				decision: { kind: "ask", id: "decision-ask", reasonCode: "approval", policyVersion: "test-v1" },
				matchedRules: [{ layer: "deployment", ruleId: "ask-test" }],
			})),
			interaction: new DurableInteractionPort(store),
		});

		let requestId = "";
		try {
			await new Runner([node]).run(ctx);
		} catch (error) {
			expect(error).toBeInstanceOf(PolicyInteractionRequiredError);
			requestId = (error as PolicyInteractionRequiredError).requestId;
		}
		expect(calls).toBe(0);
		const records = await store.get(requestId);
		expect(records).toMatchObject({
			status: "pending",
			request: { requestId },
			decision: { kind: "ask", id: "decision-ask" },
		});
	});

	it("does not emit the typed signal when interaction persistence fails", async () => {
		const node = defineNode({
			name: "effect",
			input: z.object({ value: z.string() }),
			output: z.object({ ok: z.boolean() }),
			capabilityManifest: manifest,
			execute: async () => ({ ok: true }),
		});
		const ctx = context("effect", { value: "x" });
		const audit = new InMemoryAuditSink();
		installPolicyExecution(ctx, {
			...policy(true, audit),
			provider: new InMemoryPolicyProvider(async () => ({
				decision: { kind: "ask", id: "decision-ask", reasonCode: "approval", policyVersion: "test-v1" },
				matchedRules: [],
			})),
			interaction: {
				suspend: async () => {
					throw new Error("interaction store unavailable");
				},
			},
		});

		let thrown: unknown;
		try {
			await new Runner([node]).run(ctx);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain("interaction store unavailable");
		expect(thrown).not.toBeInstanceOf(PolicyInteractionRequiredError);
	});

	it("withholds the typed signal when a port fails after recording", async () => {
		const node = defineNode({
			name: "effect",
			input: z.object({ value: z.string() }),
			output: z.object({ ok: z.boolean() }),
			capabilityManifest: manifest,
			execute: async () => ({ ok: true }),
		});
		const ctx = context("effect", { value: "x" });
		const audit = new InMemoryAuditSink();
		let persisted = false;
		installPolicyExecution(ctx, {
			...policy(true, audit),
			provider: new InMemoryPolicyProvider(async () => ({
				decision: { kind: "ask", id: "decision-ask", reasonCode: "approval", policyVersion: "test-v1" },
				matchedRules: [],
			})),
			interaction: {
				suspend: async () => {
					persisted = true;
					throw new Error("interaction acknowledgement failed");
				},
			},
		});

		let thrown: unknown;
		try {
			await new Runner([node]).run(ctx);
		} catch (error) {
			thrown = error;
		}
		expect(persisted).toBe(true);
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain("interaction acknowledgement failed");
		expect(thrown).not.toBeInstanceOf(PolicyInteractionRequiredError);
	});

	it("fails closed for a missing manifest while preserving ordinary compatibility", async () => {
		let calls = 0;
		const node = defineNode({
			name: "legacy",
			input: z.object({ value: z.string() }),
			output: z.object({ ok: z.boolean() }),
			execute: async () => {
				calls += 1;
				return { ok: true };
			},
		});
		const ordinary = context("legacy", { value: "x" });
		await new Runner([node]).run(ordinary);
		expect(calls).toBe(1);
		const agent = context("legacy", { value: "x" });
		installPolicyExecution(agent, policy(true, new InMemoryAuditSink()));
		await expect(new Runner([node]).run(agent)).rejects.toThrow(/eligible manifest/);
		expect(calls).toBe(1);
	});

	it("re-authorizes the exact persisted policy request", async () => {
		const ctx = context("effect", { value: "x" });
		const audit = new InMemoryAuditSink();
		const seen: PolicyRequest[] = [];
		const persisted: PolicyRequest = {
			requestId: "persisted-interaction",
			origin: "agent",
			principal: { id: "principal-1", kind: "test" },
			session: { id: "session-1" },
			turn: { id: "turn-1" },
			workflow: { name: "policy-test" },
			step: { id: "effect", attempt: 1 },
			manifest,
			scope: { effects: ["network"], capabilities: ["network.test"], secrets: [], fragments: {} },
			layers: [{ name: "deployment", version: "test-v1" }],
		};
		installPolicyExecution(ctx, {
			...policy(true, audit),
			provider: new InMemoryPolicyProvider(async (request) => {
				seen.push(request);
				return {
					decision: { kind: "allow", id: "decision-2", reasonCode: "still-allowed", policyVersion: "test-v1" },
					matchedRules: [],
				};
			}),
		});

		await reauthorizePolicyRequest(ctx, persisted);
		expect(seen).toEqual([persisted]);
		expect(seen[0]).toBe(persisted);
	});
	it("redacts provider-controlled decision text before audit snapshots", async () => {
		const node = defineNode({
			name: "effect",
			input: z.object({ value: z.string() }),
			output: z.object({ ok: z.boolean() }),
			capabilityManifest: manifest,
			execute: async () => ({ ok: true }),
		});
		const audit = new InMemoryAuditSink();
		const ctx = context("effect", { value: "x" });
		installPolicyExecution(ctx, {
			principal: { id: "principal-1", kind: "test" },
			session: { id: "session-1" },
			turn: { id: "turn-1" },
			attribution: {
				rootId: "run-root",
				parentId: "run-parent",
				branchId: "branch-1",
				branchIndex: 1,
				branchPath: ["parallel", "nested"],
				depth: 2,
			},
			policyVersion: "test-v1",
			provider: new InMemoryPolicyProvider(async () => ({
				decision: {
					kind: "allow",
					id: "decision-1",
					reasonCode: "policy-secret: raw-secret",
					reason: "password=raw-password",
					policyVersion: "test-v1",
				},
				matchedRules: [{ layer: "deployment", ruleId: "rule-1" }],
			})),
			auditSink: audit,
		});
		await new Runner([node]).run(ctx);
		const serialized = JSON.stringify(audit.read());
		expect(serialized).not.toContain("raw-secret");
		expect(serialized).not.toContain("raw-password");
		expect(audit.read()[0]?.redaction.redacted).toBe(true);
		expect(Object.isFrozen(audit.read()[0])).toBe(true);
		expect(audit.read()[0]?.attribution).toEqual({
			rootId: "run-root",
			parentId: "run-parent",
			branchId: "branch-1",
			branchIndex: 1,
			branchPath: ["parallel", "nested"],
			depth: 2,
		});
	});
});
