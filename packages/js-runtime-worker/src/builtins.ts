/**
 * Built-in conformance nodes, the JavaScript leg of the cross-runtime fixture
 * suite every SDK ships (each one's `registerBuiltIns`). Same names, same
 * contracts, same canonical capability manifest — that is what lets
 * `tests/e2e/cross-runtime/spec-b-typed-e2e.ts` drive this worker with the
 * exact assertions it drives the other eleven runtimes with.
 *
 * Set `BLOK_WORKER_BUILTINS=0` to serve only the project's own nodes.
 */

import { defineNode } from "@blokjs/runner/defineNode";
import type { CapabilityManifestV1 } from "@blokjs/shared";
import { z } from "zod";
import { detectHostRuntime, runtimeKindOf } from "./host.js";
import type { WorkerNode } from "./registry.js";

/** Byte-identical to `tests/fixtures/capability-manifest/typed-greet.v1.json`. */
const TYPED_GREET_MANIFEST: CapabilityManifestV1 = {
	version: "1",
	classification: "agent-compatible",
	effects: [],
	capabilities: [],
	secrets: [],
	determinism: "deterministic",
	idempotency: "idempotent",
	maturity: "stable",
	resources: {
		maxDurationMs: 5000,
		maxInputBytes: 4194304,
		maxOutputBytes: 4194304,
		maxConcurrency: 64,
	},
};

/** The `language` tag this runtime contributes to a cross-runtime chain — the
 * canonical runner kind, so `nodejs` / `bun` / `deno`. */
function language(): string {
	return runtimeKindOf(detectHostRuntime());
}

const helloWorld = defineNode({
	name: "hello-world",
	description: "Returns a greeting from the JavaScript runtime worker.",
	input: z.object({ prefix: z.string().optional() }).passthrough(),
	output: z.object({ message: z.string(), timestamp: z.string(), language: z.string() }),
	execute: (ctx, input) => {
		const body = ctx.request?.body as { name?: unknown } | undefined;
		const who = typeof body?.name === "string" && body.name.length > 0 ? body.name : "World";
		const prefix = input.prefix && input.prefix.length > 0 ? input.prefix : "Hello from the JavaScript runtime worker";
		return { message: `${prefix}, ${who}!`, timestamp: new Date().toISOString(), language: language() };
	},
});

const typedGreet = defineNode({
	name: "typed-greet",
	description: "Greets a person with a typed response.",
	capabilityManifest: TYPED_GREET_MANIFEST,
	input: z.object({ name: z.string(), repeat: z.number().int().min(1) }),
	output: z.object({ greeting: z.string(), length: z.number().int() }),
	execute: (_ctx, input) => {
		const greeting = `Hello, ${input.name}`.repeat(input.repeat);
		return { greeting, length: greeting.length };
	},
});

const chainEntry = z.object({ language: z.string(), order: z.number().int() });

const chainTest = defineNode({
	name: "chain-test",
	description: "Appends this runtime to a cross-runtime chain and returns it.",
	input: z.object({ chain: z.array(chainEntry).optional(), origin: z.string().optional() }).passthrough(),
	output: z.object({ chain: z.array(chainEntry), origin: z.string() }),
	execute: (_ctx, input) => {
		const chain = [...(input.chain ?? [])];
		chain.push({ language: language(), order: chain.length + 1 });
		return { chain, origin: input.origin ?? "unknown" };
	},
});

/**
 * Deliberately slow node, so deadline, cancellation, and backpressure have
 * something to act on over a real wire. Honours `ctx.signal` the way a
 * well-behaved node should — which is what makes cancellation observable
 * rather than merely configured.
 */
const slowEcho = defineNode({
	name: "slow-echo",
	description: "Waits for `ms` then echoes `value`; returns early when the run is cancelled.",
	input: z.object({ ms: z.number().int().min(0).max(120_000), value: z.unknown().optional() }),
	output: z.object({ value: z.unknown().optional(), aborted: z.boolean() }),
	execute: async (ctx, input) => {
		const signal = ctx.signal;
		if (signal?.aborted) return { value: input.value, aborted: true };
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, input.ms);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
		});
		return { value: input.value, aborted: signal?.aborted === true };
	},
});

/**
 * The worker-reuse probe. `pid` identifies the OS process and `executions`
 * counts what this process has served, so a caller can prove N step
 * invocations shared ONE long-lived worker rather than spawning a process per
 * step (ADR 0016 §3).
 */
function workerInfo(executions: () => number): WorkerNode {
	return defineNode({
		name: "worker-info",
		description: "Reports the worker process identity and how many executions it has served.",
		input: z.object({}).passthrough(),
		output: z.object({ pid: z.number(), runtime: z.string(), executions: z.number() }),
		execute: () => ({ pid: process.pid, runtime: language(), executions: executions() }),
	}) as unknown as WorkerNode;
}

/** Every built-in, in registration order. */
export function builtinNodes(executions: () => number): WorkerNode[] {
	return [
		helloWorld as unknown as WorkerNode,
		typedGreet as unknown as WorkerNode,
		chainTest as unknown as WorkerNode,
		slowEcho as unknown as WorkerNode,
		workerInfo(executions),
	];
}
