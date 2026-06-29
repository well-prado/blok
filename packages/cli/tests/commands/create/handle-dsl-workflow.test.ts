import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateSharedWorkflowsFile } from "../../../src/commands/create/project";

/**
 * Audit fix: a fresh `blokctl create project` (HTTP) used to ship ZERO
 * `@blokjs/core` typed-handle-DSL workflows — every generated/copied workflow
 * was the object-style `@blokjs/helper` form, so Blok's LEAD TypeScript
 * authoring surface (`workflow(name, opts, (req) => step(...))`) was invisible.
 *
 * The HTTP scaffold now ships one handle-DSL example
 * (triggers/http/src/workflows/countries-handle-dsl.ts → copied to
 * src/workflows/http/) AND registers it in the generated src/Workflows.ts so
 * it's runnable, not dead disk weight.
 */
describe("HTTP scaffold ships a runnable @blokjs/core handle-DSL workflow", () => {
	it("registers the handle-DSL example in the generated Workflows.ts", () => {
		const out = generateSharedWorkflowsFile(["http"], [], false);
		// Imported from the copied src/workflows/http/ source.
		expect(out).toContain('import CountriesHandleDsl from "./workflows/http/countries-handle-dsl";');
		// The callback DSL resolves async → registered via top-level await so the
		// resolved builder lands in the synchronous Record<string, WorkflowV2Builder>.
		expect(out).toContain('"countries-dsl": await CountriesHandleDsl,');
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

	it("does not disturb the JSON file-based routing note", () => {
		const out = generateSharedWorkflowsFile(["http"], [], false);
		expect(out).toContain("// HTTP JSON workflows are auto-discovered from workflows/json/");
	});
});
