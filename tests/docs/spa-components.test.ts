/**
 * Issue #1054 review, B2 — a static gate for the Vue and Svelte clients.
 *
 * `examples/inertia-{vue,svelte}` and `templates/spa-{vue,svelte}` had NO
 * static gate at all: `tsc --noEmit` ignores `.vue`/`.svelte`, and Biome parses
 * only their script blocks.
 *
 * This file compiles every component with the framework's own COMPILER —
 * `@vue/compiler-sfc` (a dependency of `vue`) and `svelte/compiler` (part of
 * `svelte`) — which catches exactly the class of defect that reached `main` in
 * the first round: a template that does not parse, a snippet with the wrong
 * shape, a script block terminated early by a literal `</script>` inside a
 * string. It runs over the TEMPLATES too, which no `vite build` in this repo
 * covers.
 *
 * Since #1061 the two Vite plugins ARE hoisted, so `inertia-snippets.test.ts`
 * additionally builds `examples/inertia-{vue,svelte}` for real — that is what
 * catches a component the plugin chain rejects (it caught the Vue example's
 * `defineProps<PageProps<…>>()`, which `@vue/compiler-sfc` cannot resolve).
 *
 * REMAINING GAP, stated plainly: compiling and building are not TYPE checking.
 * `vue-tsc` and `svelte-check` are still not installed, so a type error inside
 * a `.vue`/`.svelte` body is caught by neither this file nor the build.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseSfc } from "@vue/compiler-sfc";
import { compile as compileSvelte } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const VUE_DIRS = ["templates/spa-vue/src", "templates/spa-vue/kits/auth/src", "examples/inertia-vue/client/src"];
const SVELTE_DIRS = [
	"templates/spa-svelte/src",
	"templates/spa-svelte/kits/auth/src",
	"examples/inertia-svelte/client/src",
];

function walk(dir: string, ext: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full, ext));
		else if (entry.endsWith(ext)) out.push(full);
	}
	return out;
}

const vueFiles = VUE_DIRS.flatMap((dir) => walk(path.join(ROOT, dir), ".vue"));
const svelteFiles = SVELTE_DIRS.flatMap((dir) => walk(path.join(ROOT, dir), ".svelte"));

describe("every Vue component compiles", () => {
	it("finds the components to compile", () => {
		// 2 clients × (AppLayout, BlokLogo, NavLinks) + their pages, plus the
		// auth kit's GuestLayout and five pages (#1018).
		expect(vueFiles.length).toBeGreaterThanOrEqual(14);
	});

	for (const file of vueFiles) {
		const rel = path.relative(ROOT, file);
		it(`compiles ${rel}`, () => {
			const { descriptor, errors } = parseSfc(readFileSync(file, "utf8"), { filename: file });
			expect(errors.map((error) => error.message)).toEqual([]);
			// A `<script setup>` that ended early (the `</script>`-in-a-string trap)
			// shows up as a descriptor that lost its template.
			expect(descriptor.template, `${rel} has no <template>`).not.toBeNull();
		});
	}
});

describe("every Svelte component compiles", () => {
	it("finds the components to compile", () => {
		expect(svelteFiles.length).toBeGreaterThanOrEqual(6);
	});

	for (const file of svelteFiles) {
		const rel = path.relative(ROOT, file);
		it(`compiles ${rel}`, () => {
			const { warnings } = compileSvelte(readFileSync(file, "utf8"), {
				filename: file,
				generate: "client",
			});
			// The compiler THROWS on a syntax error; warnings are the a11y and
			// unused-export diagnostics, and those are failures here too.
			const reported = warnings.map((warning) => `${warning.code}: ${warning.message}`);
			expect(reported).toEqual([]);
		});
	}
});
