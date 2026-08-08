import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateSharedWorkflowsFile } from "../../../src/commands/create/project.js";

/**
 * Audit fix: a fresh `blokctl create project` (HTTP) used to ship ZERO
 * `@blokjs/core` typed-handle-DSL workflows — every generated/copied workflow
 * was the object-style `@blokjs/helper` form, so Blok's LEAD TypeScript
 * authoring surface (`workflow(name, opts, (req) => step(...))`) was invisible.
 *
 * The HTTP scaffold now ships one handle-DSL example
 * (triggers/http/src/workflows/countries-handle-dsl.ts → copied to
 * src/workflows/http/) so it's a runnable sample, not dead disk weight.
 *
 * #733 — it is deliberately NOT ALSO registered in the generated
 * src/Workflows.ts. `src/workflows/**\/*.ts` is the TS auto-routing scan root
 * (#695): the file already gets a route with zero manual entries, exactly
 * like the JSON workflows. A redundant manual registration used to dedupe
 * fine under `blokctl dev` (source, one module instance) but self-collided
 * under a BUILT `npm run start` (Workflows.ts compiles to dist and imports
 * the COMPILED module while the TS scanner imports the SOURCE file — two
 * different module instances of the "same" workflow) — every fresh HTTP
 * scaffold logged a route collision on its very first boot.
 */
describe("HTTP scaffold ships a runnable @blokjs/core handle-DSL workflow", () => {
	it("does NOT register the handle-DSL example manually — the TS scan root auto-routes it (#733)", () => {
		const out = generateSharedWorkflowsFile(["http"], [], false);
		expect(out).not.toContain("CountriesHandleDsl");
		expect(out).not.toContain("countries-dsl");
	});

	it("the shipped example actually uses the @blokjs/core handle DSL (workflow + step)", () => {
		const src = readFileSync(
			join(__dirname, "../../../../../triggers/http/src/workflows/countries-handle-dsl.ts"),
			"utf8",
		);
		// Imports the LEAD authoring surface, not the object-style @blokjs/helper.
		expect(src).toContain('from "@blokjs/core"');
		expect(src).not.toContain('from "@blokjs/helper"');
		// Uses the real exported primitives: callback-form workflow(), step(), http.
		expect(src).toMatch(/workflow\(\s*"countries\.dsl"/);
		expect(src).toContain("step(");
		expect(src).toContain("http.get(");
		// References only nodes the default scaffold's Nodes.ts registers
		// (@blokjs/api-call + HELPER_NODES' @blokjs/respond) so it runs as-is.
		expect(src).toContain('import apiCall from "@blokjs/api-call";');
		expect(src).toContain('import { RespondNode } from "@blokjs/helpers";');
	});

	it("does not disturb the auto-discovery note", () => {
		const out = generateSharedWorkflowsFile(["http"], [], false);
		expect(out).toContain("HTTP JSON + TS workflows are auto-discovered from workflows/json/ and workflows/**/*.ts");
	});
});
