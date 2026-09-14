#!/usr/bin/env bun
/**
 * Generate `docs/llms.txt` and `docs/llms-full.txt` from the SPA docs (#1019).
 *
 * An agent that has to guess at the Inertia layer guesses wrong. The docs
 * already say everything; what was missing is ONE file an agent can read
 * end-to-end without crawling 27 MDX pages and 200 Mintlify components. That is
 * `llms-full.txt`; `llms.txt` is the index of the same pages, per llmstxt.org.
 *
 * Generated, never hand-written: a second copy of the docs that drifts is worse
 * than no copy at all. `tests/docs/llms.test.ts` regenerates and diffs, so a
 * doc edit without a regenerate fails the docs gate.
 *
 * Deterministic by construction — page ORDER comes from the `docs.json`
 * navigation (which the docs gate already proves lists every SPA page), and the
 * only other input is the files' own bytes. No timestamps, no counts that a
 * reordering would churn.
 *
 * Run directly: bun run docs:llms
 * Checked by:   tests/docs/llms.test.ts (part of `bun run test`)
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(REPO_ROOT, "docs");
const SPA_DIR = join(DOCS, "d/spa");

/** One SPA doc page. */
export interface DocPage {
	/** Docs route, e.g. `d/spa/pages-and-props`. */
	route: string;
	title: string;
	description: string;
	/** The MDX body, frontmatter removed. */
	body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** One `key: value` out of a frontmatter block. Values may be quoted. */
function frontmatterValue(block: string, key: string): string {
	const match = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(block);
	const raw = (match?.[1] ?? "").trim();
	return raw.replace(/^["'](.*)["']$/, "$1");
}

/** Read one `.mdx` page, splitting frontmatter from body. */
export function readPage(route: string): DocPage {
	const source = readFileSync(join(DOCS, `${route}.mdx`), "utf8");
	const match = FRONTMATTER.exec(source);
	const block = match?.[1] ?? "";
	return {
		route,
		title: frontmatterValue(block, "title"),
		description: frontmatterValue(block, "description"),
		body: source.slice(match?.[0].length ?? 0).trim(),
	};
}

interface NavNode {
	pages?: (string | NavNode)[];
	tabs?: NavNode[];
	groups?: NavNode[];
}

/** Every route the docs navigation lists, in navigation order. */
function navRoutes(): string[] {
	const manifest = JSON.parse(readFileSync(join(DOCS, "docs.json"), "utf8")) as { navigation: NavNode };
	const out: string[] = [];
	const walk = (node: string | NavNode): void => {
		if (typeof node === "string") {
			out.push(node);
			return;
		}
		for (const child of [...(node.tabs ?? []), ...(node.groups ?? []), ...(node.pages ?? [])]) walk(child);
	};
	walk(manifest.navigation);
	return out;
}

/**
 * The SPA pages, in navigation order.
 *
 * A page on disk that the navigation does not list is appended (sorted) rather
 * than dropped: `llms.txt` promising completeness and quietly omitting a page
 * is the one failure mode worth being defensive about. The docs gate fails
 * separately on the missing nav entry.
 */
export function spaRoutes(): string[] {
	const onDisk = readdirSync(SPA_DIR)
		.filter((name) => name.endsWith(".mdx"))
		.map((name) => `d/spa/${name.replace(/\.mdx$/, "")}`);
	const known = new Set(onDisk);
	const ordered = navRoutes().filter((route) => known.has(route));
	const seen = new Set(ordered);
	return [...ordered, ...onDisk.filter((route) => !seen.has(route)).sort()];
}

const PREAMBLE = [
	"Blok is a modular workflow platform. Its SPA layer speaks the Inertia v3",
	"protocol against the stock `@inertiajs/react | vue3 | svelte` client: a page",
	"is a workflow, a prop is a step (in any runtime), and the page contract is",
	"declared once with `definePage()` outside the workflow callback so the",
	"frontend can `import type` it.",
].join("\n");

const GENERATED = "Generated from docs/d/spa/**.mdx by `bun run docs:llms` — do not edit by hand.";

/** The index file: title, one-line summary, and a link per page. */
export function buildIndex(pages: readonly DocPage[]): string {
	const lines = [
		"# Blok — SPA (Inertia)",
		"",
		`> ${GENERATED}`,
		"",
		PREAMBLE,
		"",
		"## Docs",
		"",
		...pages.map((page) => `- [${page.title}](/${page.route}): ${page.description}`),
		"",
		"## Optional",
		"",
		"- [Full text of every page above](/llms-full.txt): the same pages concatenated, for a single read.",
		"",
	];
	return lines.join("\n");
}

/** The full file: every page's prose, in the same order. */
export function buildFull(pages: readonly DocPage[]): string {
	const lines = ["# Blok — SPA (Inertia)", "", `> ${GENERATED}`, "", PREAMBLE, ""];
	for (const page of pages) {
		lines.push("", "---", "", `# ${page.title}`, "", `Source: /${page.route}`, "", page.description, "", page.body, "");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

export interface LlmsFiles {
	"llms.txt": string;
	"llms-full.txt": string;
}

/** Both files' contents. Pure — the test regenerates and diffs against disk. */
export function buildLlmsFiles(): LlmsFiles {
	const pages = spaRoutes().map(readPage);
	return { "llms.txt": buildIndex(pages), "llms-full.txt": buildFull(pages) };
}

/** Write both files. Returns their absolute paths. */
export function writeLlmsFiles(): string[] {
	const files = buildLlmsFiles();
	return Object.entries(files).map(([name, content]) => {
		const file = join(DOCS, name);
		writeFileSync(file, content, "utf8");
		return file;
	});
}

if (import.meta.main) {
	for (const file of writeLlmsFiles()) console.log(`✓ wrote ${file}`);
}
