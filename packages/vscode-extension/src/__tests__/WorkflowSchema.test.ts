import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// #303/#304 — the extension no longer ships a hand-written schema. It bundles
// a copy of the single generated `workflow.v2.json` (sourced from the Zod IR in
// @blokjs/helper). These tests assert the bundled copy is well-formed and is
// the v2 shape the extension's `contributes.jsonValidation` points at. The
// helper's `schemas.test.ts` owns the anti-drift equality check against the
// generator.
describe("Bundled workflow v2 JSON Schema", () => {
	const schemaPath = path.resolve(__dirname, "../../schemas/workflow.v2.json");
	const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as Record<string, unknown>;

	it("is valid JSON", () => {
		expect(schema).toBeDefined();
	});

	it("has the draft-07 $schema reference", () => {
		expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
	});

	it("carries the stable $id", () => {
		expect(schema.$id).toBe("https://schemas.blok.build/workflow/v2.json");
	});

	it("is the v2 shape (inline step inputs, no v1 nodes map)", () => {
		const required = (schema.required as string[]) ?? [];
		expect(required).toContain("name");
		expect(required).toContain("version");
		expect(required).toContain("steps");
		expect(required).not.toContain("nodes");
	});

	it("describes all 8 v2 step kinds plus ui + schemaVersion", () => {
		const serialized = JSON.stringify(schema);
		for (const key of [
			"schemaVersion",
			"ui",
			"branch",
			"subworkflow",
			"wait",
			"forEach",
			"loop",
			"switch",
			"tryCatch",
		]) {
			expect(serialized).toContain(`"${key}"`);
		}
	});
});
