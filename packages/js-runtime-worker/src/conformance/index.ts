/**
 * The portable conformance fixture set (ADR 0016 §4, issue #942 "Verification").
 *
 * ONE runtime-neutral set of `defineNode()` nodes, executed unchanged against
 * Node.js, Bun, and Deno. There is deliberately no per-engine fork: an engine
 * either satisfies the portable contract with these exact modules or it does
 * not. The three `*-only` nodes at the bottom are the opposite case — they
 * declare a runtime constraint and must be REFUSED by the two engines they do
 * not name.
 *
 * Registered only when `BLOK_WORKER_CONFORMANCE=1` (or `startWorker({
 * conformance: true })`), so an ordinary project's catalog is unaffected.
 */

import { defineNode } from "@blokjs/runner/defineNode";
import { z } from "zod";
import { detectHostRuntime, runtimeKindOf } from "../host.js";
import type { WorkerNode } from "../registry.js";
// Deliberately the Node-ESM `./x.js` spelling against `.ts` sources.
import { detonate } from "./lib/boom.js";
import { add } from "./lib/math.js";
import { TOP_LEVEL_AWAIT } from "./lib/tla.js";

const asWorkerNode = (node: unknown): WorkerNode => node as WorkerNode;

/** Input/output validation, both directions, from one node. */
const validate = defineNode({
	name: "conf-validate",
	description: "Doubles `n`. With `breakOutput` it returns a wrongly-typed output on purpose.",
	input: z.object({ n: z.number().int(), breakOutput: z.boolean().optional() }),
	output: z.object({ doubled: z.number().int() }),
	execute: (_ctx, input) =>
		(input.breakOutput === true ? { doubled: "not-a-number" } : { doubled: input.n * 2 }) as { doubled: number },
});

/**
 * What the documented context projection actually contains on the far side of
 * the boundary. `state` MUST be empty: the runner sends resolved inputs and the
 * projection, never accumulated workflow state (ADR 0016 §3).
 */
const context = defineNode({
	name: "conf-context",
	description: "Reports the context projection and emits correlated log lines.",
	input: z.object({ note: z.string().optional() }).passthrough(),
	output: z.object({
		runId: z.string(),
		workflowName: z.string(),
		stateKeys: z.array(z.string()),
		runtime: z.string(),
		note: z.string(),
	}),
	execute: (ctx, input) => {
		ctx.logger.log(`conf-context run=${ctx.id} note=${input.note ?? ""}`);
		ctx.logger.log("conf-context second line");
		return {
			runId: ctx.id ?? "",
			workflowName: ctx.workflow_name ?? "",
			stateKeys: Object.keys((ctx.state ?? {}) as Record<string, unknown>),
			runtime: runtimeKindOf(detectHostRuntime()),
			note: input.note ?? "",
		};
	},
});

/** Environment access. The value is read from `ctx.env` — the runner's
 * projection — never from the engine's own process environment. */
const env = defineNode({
	name: "conf-env",
	description: "Reads one variable from the context environment projection.",
	input: z.object({ name: z.string(), logIt: z.boolean().optional() }),
	output: z.object({ present: z.boolean(), value: z.string(), keys: z.number() }),
	execute: (ctx, input) => {
		const value = (ctx.env as Record<string, string> | undefined)?.[input.name];
		if (input.logIt === true) ctx.logger.log(`conf-env ${input.name}=${value ?? ""}`);
		return { present: value !== undefined, value: value ?? "", keys: Object.keys(ctx.env ?? {}).length };
	},
});

/** Async I/O over the web-standard `fetch` every engine ships. */
const fetchNode = defineNode({
	name: "conf-fetch",
	description: "Fetches a URL and reports the status and body.",
	// The `network` effect is what earns a Deno worker its --allow-net grant.
	capabilityManifest: {
		version: "1",
		classification: "agent-compatible",
		effects: ["network"],
		capabilities: ["network.http"],
		secrets: [],
		determinism: "external",
		idempotency: "idempotent",
		maturity: "stable",
	},
	input: z.object({ url: z.string() }),
	output: z.object({ status: z.number(), body: z.string() }),
	execute: async (ctx, input) => {
		const response = await fetch(input.url, { signal: ctx.signal });
		return { status: response.status, body: await response.text() };
	},
});

const thrown = defineNode({
	name: "conf-throw",
	description: "Throws a plain Error.",
	input: z.object({}).passthrough(),
	output: z.object({ never: z.string() }),
	execute: () => {
		throw new Error("conformance: thrown");
	},
});

const rejected = defineNode({
	name: "conf-reject",
	description: "Returns a rejected promise.",
	input: z.object({}).passthrough(),
	output: z.object({ never: z.string() }),
	execute: () => Promise.reject(new Error("conformance: rejected")) as Promise<{ never: string }>,
});

/** A result JSON cannot represent. The worker must answer with a structured
 * error envelope and keep serving — not die, and not return half a message. */
const nonSerializable = defineNode({
	name: "conf-non-serializable",
	description: "Returns a circular object that cannot be JSON-encoded.",
	input: z.object({}).passthrough(),
	output: z.object({ value: z.unknown() }),
	execute: () => {
		const circular: Record<string, unknown> = { name: "loop" };
		circular.self = circular;
		return { value: circular };
	},
});

/** Payload-size boundaries in both directions, in one node. */
const bytes = defineNode({
	name: "conf-bytes",
	description: "Echoes the size of the payload it received and returns `out` bytes.",
	input: z.object({
		payload: z.string().optional(),
		out: z
			.number()
			.int()
			.min(0)
			.max(64 * 1024 * 1024),
	}),
	output: z.object({ received: z.number().int(), blob: z.string() }),
	execute: (_ctx, input) => ({ received: (input.payload ?? "").length, blob: "z".repeat(input.out) }),
});

/**
 * ESM / module-resolution / npm-dependency conformance, all in one call.
 *
 * `jsonVia` is REPORTED rather than asserted: import attributes are the modern
 * spelling but are not available on every engine version in the support matrix,
 * so the fixture records which mechanism the engine actually used and the
 * conformance table carries the measurement.
 */
const modules = defineNode({
	name: "conf-modules",
	description: "Exercises relative specifiers, package exports, dynamic import, JSON, and top-level await.",
	input: z.object({}).passthrough(),
	output: z.object({
		relativeSum: z.number(),
		dynamic: z.string(),
		topLevelAwait: z.string(),
		json: z.object({ marker: z.string(), count: z.number() }),
		jsonVia: z.string(),
		npmDependency: z.string(),
		packageExports: z.boolean(),
		stack: z.string(),
	}),
	execute: async () => {
		const dynamic = (await import("./lib/dynamic.js")) as { DYNAMIC_MARKER: string };

		// JSON: the import-attribute spelling first, a URL fetch of the file as
		// the portable fallback. Both are engine-native; neither is `node:fs`.
		let json: { marker: string; count: number };
		let jsonVia: string;
		const jsonUrl = new URL("./data.json", import.meta.url);
		try {
			const imported = (await import(jsonUrl.href, { with: { type: "json" } })) as {
				default: { marker: string; count: number };
			};
			json = imported.default;
			jsonVia = "import-attribute";
		} catch {
			json = JSON.parse(await (await fetch(jsonUrl)).text()) as { marker: string; count: number };
			jsonVia = "fetch-file-url";
		}

		let stack = "";
		try {
			detonate();
		} catch (err) {
			stack = err instanceof Error ? (err.stack ?? "") : "";
		}

		return {
			relativeSum: add(2, 3),
			dynamic: dynamic.DYNAMIC_MARKER,
			topLevelAwait: TOP_LEVEL_AWAIT,
			json,
			jsonVia,
			// `zod` is an ordinary npm dependency resolved from node_modules.
			npmDependency: typeof z.object === "function" ? "zod-ok" : "zod-missing",
			// `@blokjs/runner/defineNode` is a subpath resolved through the
			// package's `exports` map — this node exists because it worked.
			packageExports: typeof defineNode === "function",
			stack,
		};
	},
});

/** Kills the worker process. Only reachable from the crash-recovery
 * conformance case, which asserts the supervisor brings it back. */
const crash = defineNode({
	name: "conf-crash",
	description: "Terminates the worker process (crash-recovery fixture).",
	input: z.object({}).passthrough(),
	output: z.object({ never: z.string() }),
	execute: () => {
		// Same abrupt death a segfaulting dependency would cause.
		process.exit(94);
	},
});

/**
 * Runtime-specific nodes. Each declares the ONE engine it supports and touches
 * an API only that engine has. Two of the three must be refused at load by any
 * given worker, with a message naming both the declaration and the engine.
 */
function runtimeSpecific(name: string, kind: string, probe: () => string): WorkerNode {
	return asWorkerNode(
		defineNode({
			name,
			description: `Requires runtime.${kind}; must be refused by every other engine.`,
			capabilityManifest: {
				version: "1",
				classification: "agent-compatible",
				effects: [],
				capabilities: [],
				secrets: [],
				determinism: "deterministic",
				idempotency: "idempotent",
				maturity: "stable",
				runtimes: [kind],
			},
			input: z.object({}).passthrough(),
			output: z.object({ engine: z.string() }),
			// The engine-specific global is touched INSIDE execute: a module-level
			// reference would fail at import and take the whole fixture file down.
			execute: () => ({ engine: probe() }),
		}),
	);
}

interface BunLike {
	version?: string;
}
interface DenoLike {
	version?: { deno?: string };
}

/** Every conformance fixture, in registration order. */
export function conformanceNodes(): WorkerNode[] {
	return [
		asWorkerNode(validate),
		asWorkerNode(context),
		asWorkerNode(env),
		asWorkerNode(fetchNode),
		asWorkerNode(thrown),
		asWorkerNode(rejected),
		asWorkerNode(nonSerializable),
		asWorkerNode(bytes),
		asWorkerNode(modules),
		asWorkerNode(crash),
		runtimeSpecific("conf-node-only", "nodejs", () => `node ${process.versions.node}`),
		runtimeSpecific(
			"conf-bun-only",
			"bun",
			() => `bun ${(globalThis as unknown as { Bun?: BunLike }).Bun?.version ?? "?"}`,
		),
		runtimeSpecific(
			"conf-deno-only",
			"deno",
			() => `deno ${(globalThis as unknown as { Deno?: DenoLike }).Deno?.version?.deno ?? "?"}`,
		),
	];
}

/** Names of the three runtime-constrained fixtures, keyed by the kind each
 * declares — the conformance driver asserts exactly one is registered. */
export const RUNTIME_SPECIFIC_FIXTURES: Readonly<Record<string, string>> = {
	nodejs: "conf-node-only",
	bun: "conf-bun-only",
	deno: "conf-deno-only",
};
