import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { examples_url } from "../../../src/commands/create/utils/Examples";

/**
 * Regression: the `--examples` success message advertised /workflow-docs,
 * /db-manager and /dashboard-gen for a year after #671 deleted those workflows
 * and their nodes — a new user's first three clicks were 404s (the same
 * confusion #669 was filed about, via stale text instead of a shipped file).
 *
 * The rot happens because nothing tied the printed list to the shipped bundle.
 * This does: every http://localhost:4000/<route> in the message must be served
 * by a workflow the scaffold actually copies — repo-root `workflows/json/*.json`
 * (copied verbatim to the project's `workflows/`) or the HTTP trigger's
 * `src/workflows/*.ts` (copied to `src/workflows/http/`).
 */
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../..");

/** Every HTTP path served by a workflow the --examples scaffold ships. */
function shippedHttpPaths(): Set<string> {
	const paths = new Set<string>();

	const jsonDir = path.join(REPO_ROOT, "workflows/json");
	for (const file of fs.readdirSync(jsonDir)) {
		if (!file.endsWith(".json")) continue;
		const wf = JSON.parse(fs.readFileSync(path.join(jsonDir, file), "utf8"));
		const httpPath = wf?.trigger?.http?.path;
		if (typeof httpPath === "string") paths.add(httpPath);
	}

	// The one typed-handle DSL example: `http.get("/countries-dsl")`.
	const tsDir = path.join(REPO_ROOT, "triggers/http/src/workflows");
	for (const file of fs.readdirSync(tsDir)) {
		if (!file.endsWith(".ts")) continue;
		const src = fs.readFileSync(path.join(tsDir, file), "utf8");
		for (const m of src.matchAll(/http\.\w+\(\s*"([^"]+)"/g)) paths.add(m[1]);
	}

	return paths;
}

describe("examples_url — advertised routes must actually ship", () => {
	it("serves every localhost:4000 path it prints", () => {
		const shipped = shippedHttpPaths();
		const advertised = [...examples_url.matchAll(/http:\/\/localhost:4000(\/[\w\-/:.]*)/g)].map((m) => m[1]);

		expect(advertised.length).toBeGreaterThan(0);
		for (const route of advertised) {
			// `:param` segments never appear in the message today; match literally.
			expect(shipped, `advertised route ${route} is not served by any shipped workflow`).toContain(route);
		}
	});

	it("names workflow files that exist in the shipped bundle", () => {
		const files = fs.readdirSync(path.join(REPO_ROOT, "workflows/json"));
		for (const m of examples_url.matchAll(/"([\w-]+\.json)"/g)) {
			expect(files, `advertised file ${m[1]} is not in workflows/json/`).toContain(m[1]);
		}
	});

	it("does not resurrect the purged 2026-07 demos", () => {
		expect(examples_url).not.toMatch(/workflow-docs|db-manager|dashboard-gen/);
	});
});
