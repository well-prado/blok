/**
 * One source of truth for the JavaScript runtime identifiers, enforced across
 * every surface that spells them (#942, "the same runtime identifiers must
 * appear everywhere; add a repository check ... to prevent drift").
 *
 * The identifiers live in `@blokjs/shared` (`JAVASCRIPT_RUNTIMES` /
 * `RUNTIME_KINDS`). Everything else — the CLI's target definitions, the LSP
 * completion list, the VS Code schema and snippets, the workflow-helper schema,
 * the docs, and the CI matrix — is a COPY, and copies drift silently: a fourth
 * engine added to the schema but not the CLI reads to a user as "supported".
 *
 * This reads the real files rather than re-declaring the lists, so the only way
 * to make it pass is to actually update the surface.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JAVASCRIPT_RUNTIMES, runtimeKindForJavaScriptRuntime } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { JAVASCRIPT_RUNTIME_DEFINITIONS } from "../../src/services/runtime-detector.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const read = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), "utf8");

/** `runtime.nodejs`, `runtime.bun`, `runtime.deno` — the step-kind spellings. */
const STEP_KINDS = JAVASCRIPT_RUNTIMES.map((target) => `runtime.${runtimeKindForJavaScriptRuntime(target)}`);

describe("JavaScript runtime identifiers do not drift", () => {
	it("the CLI's targets are exactly the shared vocabulary", () => {
		expect(JAVASCRIPT_RUNTIME_DEFINITIONS.map((d) => d.target)).toEqual([...JAVASCRIPT_RUNTIMES]);
		for (const def of JAVASCRIPT_RUNTIME_DEFINITIONS) {
			expect(def.kind, def.target).toBe(runtimeKindForJavaScriptRuntime(def.target));
		}
	});

	it.each([
		["packages/lsp-server/src/constants.ts", "LSP completion list"],
		["packages/vscode-extension/schemas/workflow.v2.json", "VS Code workflow schema"],
		["packages/vscode-extension/snippets/workflow.json", "VS Code snippets"],
		["core/workflow-helper/schemas/workflow.v2.json", "workflow-helper schema"],
		["docs/d/cli/runtimes.mdx", "runtime selection docs"],
		["docs/d/cli/runtime-troubleshooting.mdx", "runtime troubleshooting docs"],
		["docs/migration/single-to-multi-runtime.md", "migration guide"],
	])("%s lists every JavaScript step kind", (file) => {
		const contents = read(file);
		for (const kind of STEP_KINDS) {
			expect(contents, `${file} is missing ${kind}`).toContain(kind);
		}
	});

	/** The `js-runtime-targets` job block. Other jobs pin their own toolchains
	 * (`node-version: 'lts/*'` for the packaging lane, for instance), so the
	 * pins that mean "the engine this worker is proven against" are only the
	 * ones inside this job. */
	function jsTargetsJob(): string {
		const ci = read(".github/workflows/ci.yml");
		const start = ci.indexOf("\n  js-runtime-targets:");
		expect(start, "the js-runtime-targets job is gone").toBeGreaterThan(-1);
		const next = ci.indexOf("\n  cross-runtime:", start);
		return ci.slice(start, next === -1 ? undefined : next);
	}

	it("the CI job scaffolds exactly the selectable targets", () => {
		// One job loops over the engines (`for target in node bun deno; do`);
		// a per-engine matrix leg tripled the whole job for one 2-minute step.
		const loop = jsTargetsJob().match(/for target in ([a-z ]+); do/);
		expect(loop, "the js-runtime-targets engine loop is gone").not.toBeNull();
		const targets = (loop as RegExpMatchArray)[1].split(/\s+/).filter(Boolean);
		expect(targets).toEqual([...JAVASCRIPT_RUNTIMES]);
	});

	/**
	 * The pinned versions are the ones CI actually exercises AND the ones the
	 * generated deployment metadata bakes into an image. If CI moves to a
	 * different Deno and nothing updates the definition, every generated
	 * Dockerfile quietly pins a version nothing proves.
	 */
	it.each([
		["node", /node-version:\s*'([^']+)'/],
		["bun", /bun-version:\s*'([^']+)'/],
		["deno", /deno-version:\s*v?([^\s]+)/],
	])("the %s pin matches the version CI installs", (target, pattern) => {
		const found = jsTargetsJob().match(pattern);
		expect(found, `no ${target} version pin found in ci.yml`).not.toBeNull();
		const def = JAVASCRIPT_RUNTIME_DEFINITIONS.find((d) => d.target === target);
		expect(def?.pinnedVersion).toBe((found as RegExpMatchArray)[1]);
		// And the pin must satisfy the declared floor — a pin BELOW the floor
		// means CI proves something the docs say is unsupported.
		expect(def?.dockerProvision).toContain(def?.pinnedVersion as string);
	});

	/** Deno is installed in more than one lane (the targets matrix and the
	 * packaging gate). They must agree, or one lane proves a version the other
	 * does not. */
	it("pins the same Deno everywhere CI installs it", () => {
		const ci = read(".github/workflows/ci.yml");
		const pins = [...ci.matchAll(/deno-version:\s*v?([^\s]+)/g)].map((m) => m[1]);
		expect(pins.length, "no setup-deno step found").toBeGreaterThan(0);
		const expected = JAVASCRIPT_RUNTIME_DEFINITIONS.find((d) => d.target === "deno")?.pinnedVersion;
		expect(new Set(pins)).toEqual(new Set([expected]));
	});
});
