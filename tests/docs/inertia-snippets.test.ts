/**
 * The SPA docs gate (#1004).
 *
 * 1. every fenced `ts`/`tsx` block under `docs/d/spa/**` compiles against the
 *    real packages — and a fixture doc with a deliberate type error proves the
 *    check can fail;
 * 2. every internal link in those docs resolves to a page that exists;
 * 3. every page links to its counterpart on inertiajs.com, and every such link
 *    names a real v3 page;
 * 4. the Laravel comparison table covers every v3 doc page;
 * 5. the docs-site navigation lists every `/d/spa/` page;
 * 6. no example workflow uses `js/` strings or reads `ctx.state`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, docFiles, extract, materialize } from "./extract";

const SPA_DOCS = join(REPO_ROOT, "docs/d/spa");
const MIGRATION_DOC = join(REPO_ROOT, "docs/d/migration/react-node-to-inertia.mdx");
const FIXTURES = join(REPO_ROOT, "tests/docs/fixtures");
// Under node_modules so it is git- and Biome-ignored, and so `tsc` resolves
// `@blokjs/*` by walking up to the workspace symlinks.
const CACHE = join(REPO_ROOT, "node_modules/.cache");

function typecheck(outDir: string): { status: number; output: string } {
	const tsc = spawnSync("bunx", ["tsc", "--project", outDir], { cwd: REPO_ROOT, encoding: "utf8" });
	return { status: tsc.status ?? 1, output: `${tsc.stdout ?? ""}${tsc.stderr ?? ""}`.trim() };
}

describe("docs/d/spa — code samples", () => {
	const docs = [...docFiles(SPA_DOCS), MIGRATION_DOC];
	const snippets = docs.flatMap((doc) => extract(doc));

	it("finds TypeScript samples to check", () => {
		expect(docs.length).toBeGreaterThan(20);
		expect(snippets.length).toBeGreaterThan(20);
	});

	it("compiles every sample against the real packages", () => {
		expect(
			existsSync(join(REPO_ROOT, "node_modules/@blokjs/inertia/dist/index.d.ts")),
			"@blokjs/inertia is not built — run `bun run build` first",
		).toBe(true);

		const out = materialize(snippets, join(CACHE, "blok-spa-snippets"));
		const { status, output } = typecheck(out);
		expect(output, `Generated modules are in ${out}`).toBe("");
		expect(status).toBe(0);
	}, 180_000);

	it("fails on a sample with a type error (self-check)", () => {
		const broken = extract(join(FIXTURES, "broken-snippet.mdx"));
		expect(broken.length).toBeGreaterThan(0);

		const out = materialize(broken, join(CACHE, "blok-spa-snippets-selfcheck"));
		const { status, output } = typecheck(out);
		expect(status).not.toBe(0);
		expect(output).toMatch(/definePage|render|Argument of type|not assignable/);
	}, 120_000);
});

describe("docs/d/spa — links", () => {
	const docs = [...docFiles(SPA_DOCS), MIGRATION_DOC];

	it("every internal link resolves to a page that exists", () => {
		const broken: string[] = [];
		for (const doc of docs) {
			// Prose only: an `href="/orders/1"` inside a sample is app routing, not a docs link.
			const markdown = readFileSync(doc, "utf8").replace(/^```[\s\S]*?^```$/gm, "");
			for (const match of markdown.matchAll(/href="(\/[^"#]*)[^"]*"|\]\((\/[^)#]*)[^)]*\)/g)) {
				const target = (match[1] ?? match[2] ?? "").replace(/\/$/, "");
				if (target === "" || target.startsWith("/assets/")) continue;
				const page = join(REPO_ROOT, "docs", `${target}.mdx`);
				const folder = join(REPO_ROOT, "docs", target, "index.mdx");
				if (!existsSync(page) && !existsSync(folder)) {
					broken.push(`${relative(REPO_ROOT, doc)} → ${target}`);
				}
			}
		}
		expect(broken).toEqual([]);
	});

	it("every page is listed in the docs-site navigation", () => {
		const nav = readFileSync(join(REPO_ROOT, "docs/docs.json"), "utf8");
		const missing = docs
			.map((doc) => relative(join(REPO_ROOT, "docs"), doc).replace(/\.mdx$/, ""))
			.filter((route) => !nav.includes(`"${route}"`));
		expect(missing).toEqual([]);
	});
});

describe("docs/d/spa — Inertia v3 coverage", () => {
	/** The v3 half of the committed inertiajs.com/docs/llms.txt page list. */
	const v3Pages = readFileSync(join(FIXTURES, "inertia-v3-pages.txt"), "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));

	it("has a page list to check against", () => {
		expect(v3Pages.length).toBeGreaterThan(40);
	});

	it("every page links to its inertiajs.com counterpart", () => {
		const withoutCounterpart: string[] = [];
		for (const doc of docFiles(SPA_DOCS)) {
			const markdown = readFileSync(doc, "utf8");
			const links = [...markdown.matchAll(/https:\/\/inertiajs\.com\/docs\/(v3\/[\w/-]+)/g)].map((m) => m[1] as string);
			const known = links.filter((link) => v3Pages.includes(link.replace(/\/$/, "")));
			if (known.length === 0) withoutCounterpart.push(relative(REPO_ROOT, doc));
		}
		expect(withoutCounterpart).toEqual([]);
	});

	it("the comparison table has a row for every v3 doc page", () => {
		const index = readFileSync(join(SPA_DOCS, "index.mdx"), "utf8");
		const missing = v3Pages.filter((page) => !index.includes(`https://inertiajs.com/docs/${page})`));
		expect(missing).toEqual([]);
	});
});

describe("examples/inertia-* — authoring rules", () => {
	function walk(dir: string): string[] {
		if (!existsSync(dir)) return [];
		return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full);
			return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
		});
	}

	const exampleDirs = readdirSync(join(REPO_ROOT, "examples"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith("inertia-"))
		.map((entry) => join(REPO_ROOT, "examples", entry.name));

	it("ships the four examples", () => {
		expect(exampleDirs.map((dir) => relative(REPO_ROOT, dir)).sort()).toEqual([
			"examples/inertia-react",
			"examples/inertia-standalone",
			"examples/inertia-svelte",
			"examples/inertia-vue",
		]);
		for (const dir of exampleDirs) {
			expect(statSync(join(dir, "README.md")).isFile()).toBe(true);
		}
	});

	it("no example source uses a js/ expression string or reads ctx.state", () => {
		const offenders: string[] = [];
		for (const dir of exampleDirs) {
			for (const file of walk(dir)) {
				// Comments EXPLAIN these rules ("fills ctx.state.auth"); only code breaks them.
				const source = readFileSync(file, "utf8")
					.replace(/\/\*[\s\S]*?\*\//g, "")
					.replace(/^\s*\/\/[^\n]*$/gm, "");
				if (/["'`]js\//.test(source)) offenders.push(`${relative(REPO_ROOT, file)}: js/ expression string`);
				if (/ctx\.state/.test(source)) offenders.push(`${relative(REPO_ROOT, file)}: ctx.state read`);
				if (/(?::\s*any\b|\bas any\b|<any>)/.test(source)) offenders.push(`${relative(REPO_ROOT, file)}: any`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe("docs snippets — extraction rules", () => {
	it("keeps every named block inside its own page directory", () => {
		const snippets = extract(join(SPA_DOCS, "index.mdx"));
		expect(snippets.every((snippet) => snippet.path.startsWith("d-spa-index/"))).toBe(true);
	});

	it("resolves the repo root", () => {
		expect(existsSync(resolve(REPO_ROOT, "package.json"))).toBe(true);
	});
});
