/**
 * TYPE-LEVEL test for the #436 entry-body typing contract (#437 coverage): the
 * null-schema triggers — webhook / grpc / mcp / manual — type their entry handle's
 * `body` from the workflow's declared `input` Zod when present, and degrade to
 * `unknown` (NEVER `any`) when no `input` is declared. ONE rule, applied
 * consistently across all four kinds.
 *
 * Compiled by `tsc --noEmit` via `tsconfig.typetest.json` (wired into
 * `bun run typecheck`). Every `@ts-expect-error` is an assertion: if the type
 * ever widens (the error disappears) tsc fails the build. No runtime executes —
 * the workflow callbacks are wrapped in `void` and never invoked.
 *
 * Note: an entry handle is a structural `Handle<RequestShape<Body>>` proxy, so a
 * field read (`event.body.amount`) is a `Handle<number>`, NOT a bare `number` —
 * the runtime never produces the value here, only records the reference path.
 * `Exact<Handle<number>>(...)` therefore pins the leaf's witnessed type. (The
 * positive checks in stepBuilder.test.ts use bare-value asserts, but that file is
 * a `.test.ts` excluded from the typecheck target — it's compiled by esbuild
 * without type-checking, so it can't actually guard these types. This file can.)
 *
 * Why the negatives matter: the "unknown otherwise" half is the footgun
 * `EntryBodyOf` was written to avoid — `z.infer<z.ZodTypeAny>` widens an
 * UNDECLARED schema to `any`, which would silently type-check every wrong
 * downstream read. An undeclared body is `Handle<unknown>`; the brand makes it
 * assignable to `Handle<unknown>` but NOT to `Handle<string>` — an `any` degrade
 * would silently satisfy both. These assertions are the only thing that proves
 * the degrade target is `unknown`, not `any`.
 */

import { z } from "zod";
import type { Handle } from "../handles";
import { workflowCallback as workflow } from "../stepBuilder";

/** Assert the argument is EXACTLY `T` (invariant): catches both widening and narrowing. */
declare function exact<T>(value: T): void;

// ── webhook ────────────────────────────────────────────────────────────────────

// Declared input → body field handles are typed from it.
void workflow(
	"wh-typed",
	{ version: "1.0.0", input: z.object({ amount: z.number() }), trigger: { webhook: { provider: "stripe" as const } } },
	(event) => {
		exact<Handle<number>>(event.body.amount);
		// @ts-expect-error body is typed from input; `nope` is not a declared field.
		void event.body.nope;
	},
);

// No declared input → body is `Handle<unknown>`, never `Handle<any>`.
void workflow("wh-untyped", { version: "1.0.0", trigger: { webhook: { provider: "github" as const } } }, (event) => {
	exact<Handle<unknown>>(event.body);
	// @ts-expect-error an undeclared body is `Handle<unknown>`, not `Handle<any>` — not a concrete handle
	exact<Handle<string>>(event.body);
});

// ── grpc ───────────────────────────────────────────────────────────────────────

void workflow(
	"grpc-typed",
	{ version: "1.0.0", input: z.object({ id: z.string() }), trigger: { grpc: { service: "S", method: "M" } } },
	(rpc) => {
		exact<Handle<string>>(rpc.body.id);
		// @ts-expect-error body is typed from input; `missing` is not a declared field.
		void rpc.body.missing;
	},
);

// grpc with NO schema → `rpc.body` is typed `Handle<unknown>` (and the no-schema
// path does not throw at runtime — covered by entry-handles.test.ts's grpc case).
void workflow("grpc-untyped", { version: "1.0.0", trigger: { grpc: { service: "S", method: "M" } } }, (rpc) => {
	exact<Handle<unknown>>(rpc.body);
	// @ts-expect-error no-schema grpc body is `Handle<unknown>`, not `Handle<any>`
	exact<Handle<number>>(rpc.body);
});

// ── mcp ────────────────────────────────────────────────────────────────────────

void workflow(
	"mcp-typed",
	{ version: "1.0.0", input: z.object({ query: z.string() }), trigger: { mcp: { tool: "search" } } },
	(call) => {
		exact<Handle<string>>(call.body.query);
		// @ts-expect-error body is typed from input; `extra` is not a declared field.
		void call.body.extra;
	},
);

void workflow("mcp-untyped", { version: "1.0.0", trigger: { mcp: { tool: "echo" } } }, (call) => {
	exact<Handle<unknown>>(call.body);
	// @ts-expect-error no-input mcp body is `Handle<unknown>`, not `Handle<any>`
	exact<Handle<boolean>>(call.body);
});

// ── manual ─────────────────────────────────────────────────────────────────────

void workflow(
	"manual-typed",
	{ version: "1.0.0", input: z.object({ jobId: z.string() }), trigger: { manual: {} } },
	(args) => {
		exact<Handle<string>>(args.body.jobId);
		// @ts-expect-error body is typed from input; `other` is not a declared field.
		void args.body.other;
	},
);

void workflow("manual-untyped", { version: "1.0.0", trigger: { manual: {} } }, (args) => {
	exact<Handle<unknown>>(args.body);
	// @ts-expect-error no-input manual body is `Handle<unknown>`, not `Handle<any>`
	exact<Handle<string>>(args.body);
});
