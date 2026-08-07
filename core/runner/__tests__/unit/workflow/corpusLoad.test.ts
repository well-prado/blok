import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeWorkflow } from "../../../src/workflow/WorkflowNormalizer";

/**
 * #707 — every shipped workflow must LOAD.
 *
 * The repo had a corpus *validation* gate (`validateRefs.corpus.test.ts`) but
 * nothing asserting that each shipped example actually survives
 * `normalizeWorkflow`. Three broken examples shipped behind that gap
 * (two duplicate-step-id workflows and one unparseable `wait.for`).
 *
 * The bar is zero failures. `normalizeWorkflow` is the load boundary every
 * trigger funnels through, so a file that throws here is a file no user can
 * run — and, since #707, also a file carrying an unlowered `{$ref}`.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

const CORPUS_DIRS = ["examples", "workflows/json", "triggers/http/workflows", "triggers/grpc/workflows"];

function collectJson(dir: string, out: string[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) collectJson(full, out);
		else if (entry.endsWith(".json")) out.push(full);
	}
}

const files: string[] = [];
for (const dir of CORPUS_DIRS) collectJson(path.join(REPO_ROOT, dir), files);

/** A workflow document — `steps` is the discriminator; package.json etc. are not. */
const corpus = files
	.sort()
	.map((file) => {
		let doc: unknown;
		try {
			doc = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			return null;
		}
		if (doc === null || typeof doc !== "object" || !Array.isArray((doc as { steps?: unknown }).steps)) return null;
		return { rel: path.relative(REPO_ROOT, file), doc };
	})
	.filter((entry): entry is { rel: string; doc: unknown } => entry !== null);

describe("#707 corpus load gate — every shipped workflow normalizes", () => {
	it("finds the corpus (guards against a vacuous pass)", () => {
		expect(corpus.length).toBeGreaterThan(50);
	});

	it.each(corpus.map((e) => e.rel))("loads %s", (rel) => {
		const entry = corpus.find((e) => e.rel === rel);
		if (!entry) throw new Error(`corpus entry vanished: ${rel}`);
		expect(() => normalizeWorkflow(entry.doc, entry.rel)).not.toThrow();
	});
});
