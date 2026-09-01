import type { Context } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import Runner from "../../Runner";
import { defineNode } from "../../defineNode";
import {
	InMemoryAuditSink,
	InMemoryPolicyProvider,
	PolicyDeniedError,
	installPolicyExecution,
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
});
