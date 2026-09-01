import type { Context, SecretRef } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import Runner from "../../Runner";
import { encodeExecuteRequest } from "../../adapters/grpc/GrpcCodec";
import { defineNode } from "../../defineNode";
import {
	InMemoryAuditSink,
	InMemoryPolicyProvider,
	InMemorySecretResolver,
	installPolicyExecution,
	resolveSecret,
} from "../../policy/PolicyPipeline";

const reference: SecretRef = { version: "1", name: "payments.api-key" };
const manifest = {
	version: "1" as const,
	classification: "agent-compatible" as const,
	effects: ["secret"] as const,
	capabilities: ["secret.resolve"] as const,
	secrets: [reference.name] as const,
	determinism: "external" as const,
	idempotency: "idempotent" as const,
	maturity: "stable" as const,
};

function context(nodeName: string): Context {
	return {
		id: "run-secret",
		workflow_name: "secret-test",
		workflow_path: "<test>",
		request: { body: {}, headers: {}, params: {}, query: {} },
		response: { success: true, data: null, error: null },
		error: { message: [] },
		logger: { log: () => undefined } as Context["logger"],
		config: { [nodeName]: { inputs: {} } },
		eventLogger: null,
		state: {},
		vars: {},
		_PRIVATE_: {},
		env: { SAFE_VALUE: "ordinary-visible", SECRET_VALUE: "ordinary-visible-too" },
	} as Context;
}

function options(auditSink: InMemoryAuditSink, secretResolver: InMemorySecretResolver) {
	return {
		principal: { id: "principal-1", kind: "test" },
		session: { id: "session-1" },
		turn: { id: "turn-1" },
		policyVersion: "test-v1",
		provider: new InMemoryPolicyProvider(async (request) => ({
			decision: { kind: "allow", id: "decision-1", reasonCode: "allowed", policyVersion: "test-v1" },
			matchedRules: [{ layer: request.layers[0]?.name ?? "deployment", ruleId: "allow-secret" }],
		})),
		auditSink,
		secretResolver,
	};
}

describe("secret reference boundary", () => {
	it("resolves only a declared reference and audits without the value", async () => {
		const audit = new InMemoryAuditSink();
		const resolver = new InMemorySecretResolver({ [reference.name]: "super-secret" });
		const node = defineNode({
			name: "use-secret",
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			capabilityManifest: manifest,
			execute: async (ctx) => {
				const lease = await resolveSecret(ctx, reference);
				expect(lease.read()).toBe("super-secret");
				return { ok: true };
			},
		});
		const ctx = context(node.name);
		installPolicyExecution(ctx, options(audit, resolver));
		await new Runner([node]).run(ctx);
		const events = audit.read();
		expect(events.some((event) => event.eventType === "secret.resolve")).toBe(true);
		expect(JSON.stringify(events)).not.toContain("super-secret");
	});

	it("rejects an undeclared reference before consulting the resolver", async () => {
		const audit = new InMemoryAuditSink();
		let calls = 0;
		const resolver = new InMemorySecretResolver({ [reference.name]: "super-secret" });
		const original = resolver.resolve.bind(resolver);
		resolver.resolve = async (request) => {
			calls += 1;
			return original(request);
		};
		const node = defineNode({
			name: "wrong-secret",
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			capabilityManifest: { ...manifest, secrets: ["other.secret"] },
			execute: async (ctx) => {
				await resolveSecret(ctx, reference);
				return { ok: true };
			},
		});
		const ctx = context(node.name);
		installPolicyExecution(ctx, options(audit, resolver));
		await expect(new Runner([node]).run(ctx)).rejects.toThrow("SECRET_NOT_AUTHORIZED");
		expect(calls).toBe(0);
	});

	it("does not forward ambient environment values to an agent sidecar", () => {
		const node = { node: "remote", name: "remote", type: "runtime.python3" } as Parameters<
			typeof encodeExecuteRequest
		>[0];
		const ordinary = context(node.name);
		const ordinaryEnvelope = encodeExecuteRequest(node, ordinary, 0, 1, 0, 1000);
		expect(ordinaryEnvelope.state.env.SECRET_VALUE).toBe("ordinary-visible-too");
		const agent = context(node.name);
		installPolicyExecution(agent, options(new InMemoryAuditSink(), new InMemorySecretResolver({})));
		const agentEnvelope = encodeExecuteRequest(node, agent, 0, 1, 0, 1000);
		expect(agentEnvelope.state.env).toEqual({});
	});
});
