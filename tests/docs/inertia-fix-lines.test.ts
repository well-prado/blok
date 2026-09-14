/**
 * Every boot/authoring error in the SPA layer names its fix (#1019).
 *
 * An agent (and a human at 2am) reads the message, not the source. A message
 * that says only what is wrong costs a round trip; one that ends in `Fix: …`
 * is actionable on its own. `ensurePagesExist` set the convention; this makes
 * it a rule over both SPA packages.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./extract";

const PACKAGES = [join(REPO_ROOT, "nodes/web/inertia/src"), join(REPO_ROOT, "packages/inertia-client/src")];

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return sources(full);
		return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
	});
}

/**
 * The argument text of every `throw new Error(` in `source`, with its line.
 *
 * Paren-counting, not a parser: every message in these packages keeps its
 * parentheses balanced (`inertia.page()`, `(from defineNode)`), and an
 * unbalanced one would show up here as a message that fails the assertion
 * rather than as a silent pass.
 */
function thrownMessages(source: string): { line: number; text: string }[] {
	const out: { line: number; text: string }[] = [];
	const needle = "throw new Error(";
	for (let index = source.indexOf(needle); index !== -1; index = source.indexOf(needle, index + 1)) {
		let depth = 1;
		let cursor = index + needle.length;
		while (cursor < source.length && depth > 0) {
			if (source[cursor] === "(") depth += 1;
			else if (source[cursor] === ")") depth -= 1;
			cursor += 1;
		}
		out.push({
			line: source.slice(0, index).split("\n").length,
			text: source.slice(index + needle.length, cursor - 1),
		});
	}
	return out;
}

describe("SPA errors name their fix", () => {
	const files = PACKAGES.flatMap(sources);

	it("finds the sources to check", () => {
		expect(files.length).toBeGreaterThan(5);
	});

	it("every `throw new Error(` message carries a `Fix:` line", () => {
		const offenders: string[] = [];
		let checked = 0;
		for (const file of files) {
			for (const thrown of thrownMessages(readFileSync(file, "utf8"))) {
				checked += 1;
				if (!thrown.text.includes("Fix:")) {
					offenders.push(`${relative(REPO_ROOT, file)}:${thrown.line} — ${thrown.text.trim().slice(0, 80)}`);
				}
			}
		}
		expect(checked, "the throw scanner found nothing — it or the sources changed shape").toBeGreaterThan(15);
		expect(offenders).toEqual([]);
	});

	it("catches a message without one (self-check)", () => {
		const bad = thrownMessages('throw new Error("something broke (badly)");');
		expect(bad).toHaveLength(1);
		expect(bad[0]?.text.includes("Fix:")).toBe(false);
	});
});
