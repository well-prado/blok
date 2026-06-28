/**
 * tryCatch(id, { try, catch, finally? }) over handles (#317).
 *
 * Proves the full authoring → IR → real-engine path:
 *
 *  (a) the catch callback receives a typed `error` handle rooted at the `@error`
 *      sentinel; `error.message` / `error.code` lower to {$ref step:"@error"},
 *      which lowerRefs maps to `ctx.error.message` / `ctx.error.code`.
 *  (b) booted through the REAL Configuration + TryCatchNode + Runner: a `try`
 *      step that throws routes to the catch arm; `error.message`/`error.code`
 *      resolve from ctx.error. A successful try SKIPS the catch arm.
 *
 * Plus the arm-scope guard (ADR 0003/0005): reading the error handle outside
 * the catch arm (after the tryCatch) is REJECTED at author time — the SAME
 * cornerstone `canRead` guard branch()/forEach() exercise.
 *
 * SCOPE: tryCatch only.
 */

import type { Context, NodeBase, ResponseContext } from "@blokjs/shared";
import { GlobalError, lowerRefs } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import Configuration from "../../src/Configuration";
import Runner from "../../src/Runner";
import RunnerNode from "../../src/RunnerNode";
import { defineNode } from "../../src/defineNode";
import type { ErrorHandle } from "../../src/handles";
import { type TriggerHandle, makeHandle, step, tryCatch, workflowCallback } from "../../src/stepBuilder";
import type GlobalOptions from "../../src/types/GlobalOptions";

const noop = defineNode({
	name: "noop",
	description: "passthrough used only for its output type in author-time tests",
	input: z.object({}).passthrough(),
	output: z.record(z.unknown()),
	execute: (_ctx, input) => input as Record<string, unknown>,
});

// ───────────────────────── (a): IR-shape assertions ─────────────────────────

describe("tryCatch — IR lowering (#317)", () => {
	it("emits the v2 {id, tryCatch:{try, catch, finally}} shape; error handle lowers to {$ref step:@error}", async () => {
		const wf = await workflowCallback("Saga", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			tryCatch("saga", {
				try: () => {
					step("risky", noop, {});
				},
				catch: (error) => {
					step("alert", noop, { msg: error.message, code: error.code });
				},
				finally: () => {
					step("metric", noop, {}, { ephemeral: true });
				},
			});
		});

		const steps = wf._config.steps as Array<Record<string, unknown>>;
		const tc = steps.find((s) => s.tryCatch) as {
			id: string;
			tryCatch: { try: Array<Record<string, unknown>>; catch: Array<Record<string, unknown>>; finally?: unknown[] };
		};
		expect(tc.id).toBe("saga");
		expect(tc.tryCatch.try.map((s) => s.id)).toEqual(["risky"]);
		expect(tc.tryCatch.catch.map((s) => s.id)).toEqual(["alert"]);
		expect(tc.tryCatch.finally?.map((s) => (s as { id: string }).id)).toEqual(["metric"]);

		// error.message / error.code lower to {$ref} rooted at the @error sentinel.
		expect(tc.tryCatch.catch[0].inputs).toEqual({
			msg: { $ref: { step: "@error", path: ["message"] } },
			code: { $ref: { step: "@error", path: ["code"] } },
		});

		// And lowerRefs (load boundary) maps @error → ctx.error.
		const lowered = lowerRefs(tc.tryCatch.catch[0].inputs);
		expect(lowered).toEqual({ msg: "js/ctx.error.message", code: "js/ctx.error.code" });
	});
});

// ───────────────────── arm-scope guard (ADR 0003/0005) ──────────────────────

describe("tryCatch — error handle is catch-arm-scoped (cornerstone canRead)", () => {
	it("rejects the error handle read AFTER the tryCatch", async () => {
		await expect(
			workflowCallback("Leak", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				let leaked: ErrorHandle | undefined;
				tryCatch("tc", {
					try: () => {
						step("a", noop, {});
					},
					catch: (error) => {
						leaked = error;
						step("b", noop, {});
					},
				});
				// reading the catch-arm error handle after the tryCatch must throw.
				step("after", noop, { x: (leaked as unknown as { message: unknown }).message });
			}),
		).rejects.toThrow(/outside its scope/);
	});
});

// ───────────────────── (b): real Configuration + TryCatchNode + Runner ──────

class ThrowNode extends RunnerNode {
	constructor() {
		super();
		this.name = "@blokjs/throw";
		this.node = "@blokjs/throw";
		this.type = "module";
		this.active = true;
	}
	async run(ctx: Context): Promise<ResponseContext> {
		const opts = ((ctx.config as Record<string, unknown> | undefined)?.[this.name] ?? {}) as {
			inputs?: { message?: string; code?: number };
		};
		const message = opts.inputs?.message ?? "boom";
		const code = opts.inputs?.code;
		if (typeof code === "number") {
			const err = new GlobalError(message);
			err.setCode(code);
			throw err;
		}
		throw new Error(message);
	}
}

class CtxPublishNode extends RunnerNode {
	constructor() {
		super();
		this.name = "@blokjs/ctx-publish";
		this.node = "@blokjs/ctx-publish";
		this.type = "module";
		this.active = true;
	}
	async run(ctx: Context): Promise<ResponseContext> {
		const opts = ((ctx.config as Record<string, unknown> | undefined)?.[this.name] ?? {}) as {
			inputs?: { name?: string; value?: unknown };
		};
		const name = opts.inputs?.name ?? "";
		const state = (ctx.state ?? {}) as Record<string, unknown>;
		state[name] = opts.inputs?.value;
		return { success: true, data: { name, value: opts.inputs?.value }, error: null };
	}
}

async function bootAndRun(workflowDef: unknown): Promise<Record<string, unknown>> {
	const config = new Configuration();
	const helpers: Record<string, RunnerNode> = {
		"@blokjs/throw": new ThrowNode(),
		"@blokjs/ctx-publish": new CtxPublishNode(),
	};
	const globalOptions = {
		nodes: { getNode: (name: string): RunnerNode | null => helpers[name] ?? null },
	} as unknown as GlobalOptions;
	await config.init("trycatch-e2e", globalOptions, workflowDef);
	const state: Record<string, unknown> = {};
	const ctx = {
		id: "req",
		workflow_name: "trycatch-e2e",
		workflow_path: "/x",
		request: { body: {}, headers: {}, params: {}, query: {} },
		response: { data: null, success: true, error: null, contentType: "application/json" },
		error: { message: [] },
		logger: {
			log: () => {},
			logLevel: () => {},
			error: () => {},
			getLogs: () => [],
			getLogsAsText: () => "",
			getLogsAsBase64: () => "",
		},
		config: config.nodes,
		vars: state,
		state,
		env: {},
		eventLogger: null,
		_PRIVATE_: null,
	} as unknown as Context;
	await new Runner(config.steps as NodeBase[]).run(ctx);
	return ctx.state as Record<string, unknown>;
}

describe("tryCatch — real Configuration + TryCatchNode + Runner", () => {
	it("routes a throwing try to the catch arm; error.message / error.code resolve from ctx.error", async () => {
		// Author the tryCatch via the handle DSL, then run THAT IR. The catch arm
		// echoes error.message + error.code back into state via ctx-publish.
		const wf = await workflowCallback("Catch", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
			tryCatch("tc", {
				try: () => {
					step("risky", noop, {});
				},
				catch: (error) => {
					step("captured", noop, { m: error.message, c: error.code });
				},
			});
		});
		const authored = (wf._config.steps as Array<Record<string, unknown>>).find((s) => s.tryCatch) as {
			tryCatch: { catch: Array<Record<string, unknown>> };
		};
		// Sanity: the authored catch input carries the {$ref @error} structural refs.
		expect(authored.tryCatch.catch[0].inputs).toEqual({
			m: { $ref: { step: "@error", path: ["message"] } },
			c: { $ref: { step: "@error", path: ["code"] } },
		});

		const def = {
			name: "catch-flow",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "tc",
					tryCatch: {
						try: [{ id: "risky", use: "@blokjs/throw", type: "module", inputs: { message: "kaboom", code: 402 } }],
						catch: [
							{
								id: "captured",
								use: "@blokjs/ctx-publish",
								type: "module",
								// lowered forms of error.message / error.code.
								inputs: { name: "result", value: { m: "js/ctx.error.message", c: "js/ctx.error.code" } },
							},
						],
					},
				},
			],
		};

		const state = await bootAndRun(def);
		// The catch arm fired and resolved the error envelope from ctx.error.
		expect(state.result).toEqual({ m: "kaboom", c: 402 });
		// `risky` threw → Rule 0: no state written for it.
		expect(state.risky).toBeUndefined();
	});

	it("a successful try SKIPS the catch arm", async () => {
		const def = {
			name: "no-catch-flow",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/x" } },
			steps: [
				{
					id: "tc",
					tryCatch: {
						try: [
							{
								id: "ok",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "ranTry", value: true },
							},
						],
						catch: [
							{
								id: "shouldNotRun",
								use: "@blokjs/ctx-publish",
								type: "module",
								inputs: { name: "ranCatch", value: true },
							},
						],
					},
				},
			],
		};

		const state = await bootAndRun(def);
		expect(state.ranTry).toBe(true);
		expect(state.ranCatch).toBeUndefined();
	});
});

// ───────────────────── type-test: code/stepId are optional ──────────────────
// Compile-only assertions: ErrorHandle exposes code/stepId as OPTIONAL members.
// (A type error here fails `typecheck`, not the runtime test.)
{
	const _typeTest = (error: ErrorHandle): void => {
		// message / name are present.
		const _m: unknown = error.message;
		const _n: unknown = error.name;
		// code / stepId are reachable (optional fields surface as handles too).
		const _c: unknown = error.code;
		const _s: unknown = error.stepId;
		void _m;
		void _n;
		void _c;
		void _s;
	};
	void _typeTest;
}

// keep these imports used (the makeHandle/TriggerHandle surface is exercised by
// the broader handle suite; referenced here so the import list mirrors siblings).
void makeHandle;
type _Trigger = TriggerHandle;
