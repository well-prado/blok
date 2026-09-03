import type { CapabilityAuthority, PolicyContext, PolicyEvaluationResult } from "@blokjs/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeCodeMode, validateCodeModeSource } from "../src";
import type { CodeModeBinding } from "../src";

const pureAuthority: CapabilityAuthority = { effects: [], capabilities: [], secrets: [], fragments: {} };
const pureManifest = {
	version: "1" as const,
	classification: "agent-compatible" as const,
	effects: [],
	capabilities: [],
	secrets: [],
	determinism: "deterministic" as const,
	idempotency: "idempotent" as const,
	maturity: "stable" as const,
};

function context(scope: CapabilityAuthority = pureAuthority): PolicyContext {
	return {
		origin: "agent",
		principal: { id: "principal-1", kind: "agent" },
		session: { id: "session-1" },
		turn: { id: "turn-1" },
		workflow: { name: "code-mode-test", version: "1" },
		step: { id: "code-mode" },
		manifest: null,
		scope,
		layers: [{ name: "phase", version: "1" }],
	};
}

function allowPolicy(calls: PolicyContext[] = []): {
	context: PolicyContext;
	authorize: { authorize: (request: PolicyContext) => Promise<PolicyEvaluationResult> };
} {
	return {
		context: context(),
		authorize: {
			async authorize(request) {
				calls.push(request);
				return {
					decision: { kind: "allow", id: `decision-${calls.length}`, reasonCode: "test", policyVersion: "1" },
					matchedRules: [],
				};
			},
		},
	};
}

function binding(
	name: string,
	invoke: CodeModeBinding["invoke"],
	manifest = pureManifest,
	authority = pureAuthority,
	input = z.record(z.unknown()),
): CodeModeBinding {
	return {
		name,
		input,
		output: z.record(z.unknown()),
		manifest,
		authority,
		invoke,
	};
}

describe("Code Mode source validation", () => {
	it("accepts erasable TypeScript and reports source locations", () => {
		const result = validateCodeModeSource("const value: number = input.value as number; return { value: value + 1 };");
		expect(result.valid).toBe(true);
		expect(result.transpiledSource).toContain("return { value: value + 1 }");
	});

	it.each([
		["import fs from 'node:fs'", "construct"],
		["return process.env.SECRET", "process"],
		["return fs.readFile('secret')", "fs"],
		["return fetch(input.url)", "fetch"],
		["return globalThis", "globalThis"],
		["return eval('1 + 1')", "eval"],
		["return Function('return 1')()", "Function"],
		["return new Date()", "object construction"],
		["return import('node:fs')", "dynamic module loading"],
		["return input.constructor", "constructor"],
		["return /secret/.test(input.value)", "regular expressions"],
		["return 'js/ctx.state.secret'", "Blok expression"],
	] as const)("rejects %s", (source, expected) => {
		const result = validateCodeModeSource(source);
		expect(result.valid).toBe(false);
		expect(result.issues.some((issue) => issue.message.includes(expected))).toBe(true);
		expect(result.issues[0]?.line).toBeGreaterThan(0);
	});
});

describe("executeCodeMode", () => {
	it("runs in a fresh context with schema validation and policy before the handler", async () => {
		const calls: PolicyContext[] = [];
		const order: string[] = [];
		const policy = allowPolicy(calls);
		const lookup = binding("lookup", async (input) => {
			order.push(`handler:${JSON.stringify(input)}`);
			return { result: "found" };
		});
		const result = await executeCodeMode({
			source: "const found: { result: string } = await bindings.lookup({ key: input.key }); log(found); return found;",
			input: { key: "alpha" },
			bindings: [lookup],
			policy: { authorization: policy.authorize, policyVersion: "1", context: policy.context },
		});
		expect(result.output).toEqual({ result: "found" });
		expect(result.logs).toEqual([{ value: { result: "found" } }]);
		expect(result.calls).toBe(1);
		expect(calls).toHaveLength(1);
		expect(order).toEqual(['handler:{"key":"alpha"}']);
	});

	it("fails closed when policy denies and never invokes the handler", async () => {
		const handler = vi.fn(() => ({ result: "must-not-run" }));
		const denied = {
			async authorize(): Promise<PolicyEvaluationResult> {
				return {
					decision: { kind: "deny", id: "decision-1", reasonCode: "out-of-phase", policyVersion: "1" },
					matchedRules: [],
				};
			},
		};
		await expect(
			executeCodeMode({
				source: "return await bindings.lookup({});",
				bindings: [binding("lookup", handler)],
				policy: { authorization: denied, policyVersion: "1", context: context() },
			}),
		).rejects.toMatchObject({ code: "CODE_MODE_POLICY_DENIED" });
		expect(handler).not.toHaveBeenCalled();
	});

	it("rejects secret bindings and validates binding schemas at the boundary", async () => {
		const secretManifest = {
			...pureManifest,
			effects: ["secret"] as ["secret"],
			capabilities: ["secret.resolve"],
			secrets: ["db.password"],
		};
		const secretAuthority: CapabilityAuthority = {
			effects: ["secret"],
			capabilities: ["secret.resolve"],
			secrets: ["db.password"],
			fragments: {},
		};
		await expect(
			executeCodeMode({
				source: "return null;",
				bindings: [binding("secret", async () => ({ value: "hidden" }), secretManifest, secretAuthority)],
			}),
		).rejects.toMatchObject({ code: "CODE_MODE_BINDING_REJECTED" });

		const handler = vi.fn(() => ({ result: "found" }));
		const typed = binding("typed", handler, pureManifest, pureAuthority, z.object({ key: z.string() }));
		await expect(
			executeCodeMode({
				source: "try { return await bindings.typed({ key: 42 }); } catch { return { rejected: true }; }",
				bindings: [typed],
				policy: { authorization: allowPolicy().authorize, policyVersion: "1", context: context() },
			}),
		).resolves.toMatchObject({ output: { rejected: true }, calls: 1 });
		expect(handler).not.toHaveBeenCalled();
	});

	it("enforces output, call, and parallelism budgets", async () => {
		await expect(
			executeCodeMode({ source: "return 'x'.repeat(100);", budgets: { maxOutputBytes: 16 } }),
		).rejects.toMatchObject({ code: "CODE_MODE_OUTPUT_LIMIT" });
		const policy = allowPolicy();
		const read = binding("read", async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			return { ok: true };
		});
		await expect(
			executeCodeMode({
				source: "return await bindings.read({});",
				bindings: [read],
				policy: { authorization: policy.authorize, policyVersion: "1", context: policy.context },
				budgets: { maxCalls: 1 },
			}),
		).resolves.toMatchObject({ calls: 1 });
		await expect(
			executeCodeMode({
				source: "return await Promise.all([bindings.read({}), bindings.read({})]);",
				bindings: [read],
				policy: { authorization: policy.authorize, policyVersion: "1", context: policy.context },
				budgets: { maxParallelism: 1 },
			}),
		).rejects.toMatchObject({ code: "CODE_MODE_PARALLELISM_LIMIT" });
		await expect(
			executeCodeMode({
				source: "return await Promise.all([bindings.read({}), bindings.read({})]);",
				bindings: [read],
				policy: { authorization: policy.authorize, policyVersion: "1", context: policy.context },
				budgets: { maxCalls: 1 },
			}),
		).rejects.toMatchObject({ code: "CODE_MODE_CALL_LIMIT" });
	});

	it("enforces wall time and cancellation by terminating the worker", async () => {
		await expect(executeCodeMode({ source: "while (true) {}", budgets: { maxWallTimeMs: 50 } })).rejects.toMatchObject({
			code: "CODE_MODE_TIMEOUT",
		});
		const controller = new AbortController();
		const pending = executeCodeMode({
			source: "while (true) {}",
			signal: controller.signal,
			budgets: { maxWallTimeMs: 5_000 },
		});
		setTimeout(() => controller.abort(), 25);
		await expect(pending).rejects.toMatchObject({ code: "CODE_MODE_CANCELLED" });
	});

	it("enforces the worker heap ceiling", async () => {
		await expect(
			executeCodeMode({
				source: "const values: string[] = []; while (true) values.push('allocation'); return values.length;",
				budgets: { maxMemoryBytes: 16 * 1024 * 1024, maxWallTimeMs: 5_000 },
			}),
		).rejects.toMatchObject({ code: "CODE_MODE_MEMORY_LIMIT" });
	});

	it("keeps nested calls on the parent authority and policy path", async () => {
		const calls: PolicyContext[] = [];
		const policy = allowPolicy(calls);
		const writeAuthority: CapabilityAuthority = {
			effects: ["write"],
			capabilities: ["workspace.write"],
			secrets: [],
			fragments: {},
		};
		const writeManifest = { ...pureManifest, effects: ["write"] as ["write"], capabilities: ["workspace.write"] };
		const outer = binding("outer", async (_input, callContext) => callContext.call("write", {}));
		const write = binding("write", async () => ({ ok: true }), writeManifest, writeAuthority);
		const result = await executeCodeMode({
			source: "try { return await bindings.outer({}); } catch { return { denied: true }; }",
			bindings: [outer, write],
			policy: { authorization: policy.authorize, policyVersion: "1", context: context() },
		});
		expect(result.output).toEqual({ denied: true });
		expect(calls).toHaveLength(1);
	});
});
