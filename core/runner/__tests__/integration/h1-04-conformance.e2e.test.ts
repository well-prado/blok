/**
 * H1-04 runner-facing conformance. This suite uses the runner's public policy
 * exports and the shared CapabilityAuthority contract; nested control-flow,
 * scheduler, and runtime transport behavior remains covered by the focused
 * suites listed in the architecture campaign document.
 */
import type { Context, PolicyEvaluationResult, PolicyRequest } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	InMemoryAuditSink,
	PolicyDeniedError,
	authorizeStep,
	defineNode,
	installPolicyExecution,
	propagatePolicyExecution,
	validateChildPolicyAuthority,
} from "../../src";

const parentAuthority = {
	effects: ["read", "network"],
	capabilities: ["workspace.read", "network.http"],
	secrets: [],
	fragments: { workspace: "repo-a" },
} as const;

const manifest = {
	version: "1" as const,
	classification: "agent-compatible" as const,
	effects: ["read", "network"] as const,
	capabilities: ["workspace.read", "network.http"] as const,
	secrets: [] as const,
	determinism: "external" as const,
	idempotency: "idempotent" as const,
	maturity: "stable" as const,
};

function context(workflowName: string, signal?: AbortSignal): Context {
	const state: Record<string, unknown> = {};
	return {
		id: `${workflowName}-run`,
		workflow_name: workflowName,
		workflow_path: "<h1-04-test>",
		request: { body: {}, headers: {}, params: {}, query: {} },
		response: { success: true, data: null, error: null },
		error: { message: [] },
		logger: { log: () => undefined } as Context["logger"],
		config: {},
		eventLogger: null,
		state,
		vars: state,
		_PRIVATE_: {},
		...(signal ? { signal } : {}),
	} as Context;
}

function allowResult(scope?: PolicyRequest["scope"]): PolicyEvaluationResult {
	return {
		decision: { kind: "allow", id: "allow-h1-04", reasonCode: "allowed", policyVersion: "h1-04" },
		matchedRules: [{ layer: "deployment", ruleId: "h1-04-allow" }],
		...(scope ? { scope } : {}),
	};
}

function install(
	ctx: Context,
	provider: (request: PolicyRequest) => Promise<PolicyEvaluationResult>,
): InMemoryAuditSink {
	const audit = new InMemoryAuditSink();
	installPolicyExecution(ctx, {
		principal: { id: "principal-h1-04", kind: "test" },
		session: { id: "session-h1-04" },
		turn: { id: "turn-h1-04" },
		policyVersion: "h1-04",
		provider: { evaluate: provider },
		auditSink: audit,
		authority: parentAuthority,
	});
	return audit;
}

describe("H1-04 runner permission inheritance", () => {
	it("narrows a propagated child to the parent intersection before authorization", async () => {
		const seen: PolicyRequest[] = [];
		const parent = context("parent-workflow");
		install(parent, async (request) => {
			seen.push(request);
			return allowResult();
		});

		const child = context("child-workflow");
		const effective = propagatePolicyExecution(parent, child, {
			effects: ["read"],
			capabilities: ["workspace.read"],
			secrets: [],
			fragments: { workspace: "repo-a" },
		});
		const node = defineNode({
			name: "child-read",
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			capabilityManifest: manifest,
			execute: async () => ({ ok: true }),
		});

		const token = await authorizeStep(child, node, 1);
		expect(effective).toEqual({
			effects: ["read"],
			capabilities: ["workspace.read"],
			secrets: [],
			fragments: { workspace: "repo-a" },
		});
		const leafScope = { ...effective, fragments: {} };
		expect(token?.request.scope).toEqual(leafScope);
		expect(seen[0]?.scope).toEqual(leafScope);
	});

	it("rejects widened child authority before child policy state is installed", () => {
		const parent = context("parent-workflow");
		install(parent, async () => allowResult());
		const child = context("widened-child");

		expect(() =>
			propagatePolicyExecution(parent, child, {
				effects: ["read", "network", "write"],
				capabilities: ["workspace.read", "network.http", "shell.exec"],
				secrets: [],
				fragments: { workspace: "repo-a" },
			}),
		).toThrow(/unauthorized value/);
		expect(() =>
			validateChildPolicyAuthority(parent, {
				effects: ["write"],
				capabilities: ["shell.exec"],
				secrets: [],
				fragments: { workspace: "repo-a" },
			}),
		).toThrow(/unauthorized value/);
	});

	it("fails closed when the active policy returns a widened scope", async () => {
		const ctx = context("policy-widened");
		install(ctx, async () =>
			allowResult({
				effects: ["read", "write"],
				capabilities: ["workspace.read", "workspace.write"],
				secrets: [],
				fragments: { workspace: "repo-a" },
			}),
		);
		const node = defineNode({
			name: "read-node",
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			capabilityManifest: manifest,
			execute: async () => ({ ok: true }),
		});

		await expect(authorizeStep(ctx, node, 1)).rejects.toMatchObject({ reasonCode: "malformed-policy-scope" });
	});

	it("does not turn a cancelled execution into an authorized success", async () => {
		const controller = new AbortController();
		controller.abort();
		const ctx = context("cancelled", controller.signal);
		let providerCalls = 0;
		install(ctx, async () => {
			providerCalls += 1;
			return allowResult();
		});
		const node = defineNode({
			name: "cancelled-node",
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			capabilityManifest: manifest,
			execute: async () => ({ ok: true }),
		});

		await expect(authorizeStep(ctx, node, 1)).rejects.toBeInstanceOf(PolicyDeniedError);
		expect(providerCalls).toBe(0);
	});
});
