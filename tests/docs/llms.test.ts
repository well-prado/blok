/**
 * The `llms.txt` gate (#1019).
 *
 * `docs/llms.txt` and `docs/llms-full.txt` are GENERATED from the SPA MDX, so
 * the only way they can be wrong is by being stale. This regenerates them in
 * memory and diffs against what is committed: a doc edit without a
 * `bun run docs:llms` fails here, which is the whole point of generating them.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, buildLlmsFiles, readPage, spaRoutes } from "../../scripts/gen-llms-txt";
import { docFiles } from "./extract";

const SPA_DOCS = join(REPO_ROOT, "docs/d/spa");

function committed(name: string): string {
	return readFileSync(join(REPO_ROOT, "docs", name), "utf8");
}

describe("docs/llms.txt", () => {
	const generated = buildLlmsFiles();

	it("is up to date with the SPA docs (run `bun run docs:llms`)", () => {
		expect(committed("llms.txt")).toBe(generated["llms.txt"]);
		expect(committed("llms-full.txt")).toBe(generated["llms-full.txt"]);
	});

	it("is deterministic — generating twice yields identical files", () => {
		const again = buildLlmsFiles();
		expect(again["llms.txt"]).toBe(generated["llms.txt"]);
		expect(again["llms-full.txt"]).toBe(generated["llms-full.txt"]);
	});

	it("lists every docs/d/spa/*.mdx title, and links every page", () => {
		const routes = docFiles(SPA_DOCS).map(
			(file) =>
				`d/spa/${file
					.split("/")
					.pop()
					?.replace(/\.mdx$/, "")}`,
		);
		expect(routes.length).toBeGreaterThanOrEqual(25);
		expect(spaRoutes().slice().sort()).toEqual(routes.slice().sort());

		for (const route of routes) {
			const page = readPage(route);
			expect(page.title, `${route} has no frontmatter title`).not.toBe("");
			expect(generated["llms.txt"]).toContain(`[${page.title}](/${route})`);
			expect(generated["llms-full.txt"]).toContain(`Source: /${route}`);
		}
	});

	it("carries the full prose of every page, not just the titles", () => {
		for (const route of spaRoutes()) {
			const page = readPage(route);
			// The last paragraph-ish line of the page: if only the frontmatter were
			// copied, this would be missing.
			const tail = page.body
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.at(-1) as string;
			expect(generated["llms-full.txt"], `${route} body is truncated`).toContain(tail);
		}
		expect(generated["llms-full.txt"].length).toBeGreaterThan(50_000);
	});
});
