import * as core from "@blokjs/core";
import * as coreRuntime from "@blokjs/core/runtime";
import type { Context, NodeBase } from "@blokjs/core/runtime";
import * as coreTesting from "@blokjs/core/testing";
import * as runner from "@blokjs/runner";
import * as runnerTesting from "@blokjs/runner/testing";
import * as shared from "@blokjs/shared";
import { describe, expect, it } from "vitest";

/**
 * #379 — the deprecated packages (`@blokjs/runner`, `@blokjs/shared`,
 * `@blokjs/helper`) stay published as back-compat aliases (#378), and `@blokjs/core`
 * must be a COMPLETE migration target: every symbol importable from the old
 * packages has to be reachable through a `@blokjs/core` subpath, or "import only
 * `@blokjs/core`" is a lie.
 *
 * The runner/shared/testing checks are REGENERABLE — they derive the expected set
 * from the real barrels at runtime, so the test tightens automatically when the
 * surface grows (no hand-maintained list to drift). Runtime `in` checks cover
 * VALUE exports; the `import type` line below proves the type surface is reachable
 * too (the file fails to compile if `@blokjs/core/runtime` can't resolve them).
 */

const valueNames = (m: object): string[] => Object.keys(m).filter((k) => k !== "default");

describe("@blokjs/core is a complete migration target for the deprecated packages (#379)", () => {
	it("@blokjs/core/runtime re-exports every @blokjs/runner value export", () => {
		const missing = valueNames(runner).filter((k) => !(k in coreRuntime));
		expect(missing).toEqual([]);
	});

	it("@blokjs/core/runtime re-exports every @blokjs/shared value export", () => {
		const missing = valueNames(shared).filter((k) => !(k in coreRuntime));
		expect(missing).toEqual([]);
	});

	it("@blokjs/core/testing re-exports every @blokjs/runner/testing value export", () => {
		const missing = valueNames(runnerTesting).filter((k) => !(k in coreTesting));
		expect(missing).toEqual([]);
	});

	it("the type surface is reachable via @blokjs/core/runtime (compile-time)", () => {
		// If `@blokjs/core/runtime` did not surface these types, this file would
		// fail to typecheck. The runtime assertion is a placeholder for the
		// compile-time guarantee.
		const proof: [Context?, NodeBase?] = [];
		expect(proof).toEqual([]);
	});

	it("@blokjs/core (.) exposes the documented authoring DSL surface", () => {
		// The `.` entry is a CURATED light surface (not a blanket re-export of
		// @blokjs/helper), so the author-facing DSL the scaffold + docs promise is
		// asserted explicitly. Adding a new DSL primitive should extend this list.
		const DSL = [
			"workflow",
			"step",
			"subworkflow",
			"branch",
			"forEach",
			"switchOn",
			"tryCatch",
			"tpl",
			"js",
			"$",
			"http",
			"eq",
			"ne",
			"gt",
			"gte",
			"lt",
			"lte",
			"not",
			"defineNode",
			"runtimeNode",
		];
		const missing = DSL.filter((k) => !(k in core));
		expect(missing).toEqual([]);
	});
});
