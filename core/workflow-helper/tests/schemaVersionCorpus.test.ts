import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKFLOW_IR_VERSION, WorkflowIRSchema, workflow } from "../src/index";

/**
 * Issue #299 (TEST-ONLY) — prove PR #454 (added `schemaVersion` to
 * WorkflowV2Schema/WorkflowIRSchema, defaults "2", rejects "3") did not
 * regress the existing workflow corpus.
 *
 * Two halves:
 *  1. Schema-level default / round-trip / reject behaviour for `schemaVersion`.
 *  2. CORPUS REGRESSION — every real JSON workflow under
 *     triggers/http/workflows/json is parsed with and without `schemaVersion`;
 *     the success/failure verdict MUST be identical (adding the field changed
 *     nothing), and every file that parses MUST default `schemaVersion` to "2".
 */

const minimalStep = { id: "x", use: "@blokjs/respond", inputs: {} } as const;
const base = {
	name: "ValidName",
	version: "1.0.0",
	trigger: { http: { method: "GET", path: "/x" } },
	steps: [minimalStep],
} as const;

describe("schemaVersion — schema default / round-trip / reject", () => {
	it('defaults to "2" on _config and toJson() when absent', () => {
		const wf = workflow({ ...base });
		expect(wf._config.schemaVersion).toBe("2");
		expect(JSON.parse(wf.toJson()).schemaVersion).toBe("2");
		expect(WORKFLOW_IR_VERSION).toBe("2");
	});

	it('WorkflowIRSchema.safeParse defaults absent schemaVersion to "2"', () => {
		const parsed = WorkflowIRSchema.safeParse({
			name: "ValidName",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [minimalStep],
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.schemaVersion).toBe("2");
	});

	it('round-trips explicit "2" through workflow() → toJson() → JSON.parse', () => {
		const wf = workflow({ ...base, schemaVersion: "2" });
		const round = JSON.parse(wf.toJson());
		expect(round.schemaVersion).toBe("2");
		// And the round-tripped JSON re-parses clean under the IR schema.
		expect(WorkflowIRSchema.safeParse(round).success).toBe(true);
	});

	it('rejects unsupported "3" (factory + schema)', () => {
		expect(() => workflow({ ...base, schemaVersion: "3" } as unknown as Parameters<typeof workflow>[0])).toThrow(
			/failed validation/,
		);
		expect(WorkflowIRSchema.safeParse({ ...base, schemaVersion: "3" }).success).toBe(false);
	});

	// T2 decision: a typo'd schemaVersion is an unsupported value → rejected
	// (the schema is a `z.literal("2")`, so anything that isn't exactly "2" or
	// absent fails). Mirrors the "3" case.
	it("rejects a typo'd schemaVersion value", () => {
		expect(WorkflowIRSchema.safeParse({ ...base, schemaVersion: "2.0" }).success).toBe(false);
		expect(WorkflowIRSchema.safeParse({ ...base, schemaVersion: 2 }).success).toBe(false);
	});
});

// --- corpus regression -------------------------------------------------------

const CORPUS_DIR = join(import.meta.dirname, "../../../triggers/http/workflows/json");

function walkJson(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		out.push(...(statSync(p).isDirectory() ? walkJson(p) : p.endsWith(".json") ? [p] : []));
	}
	return out;
}

const corpus = walkJson(CORPUS_DIR);

describe("schemaVersion — existing-workflow corpus regression (#299)", () => {
	it("enumerates a representative corpus of real JSON workflows", () => {
		// Guards against a silently-empty glob turning every per-file assertion
		// below into a no-op. The repo ships dozens of fixture workflows.
		expect(corpus.length).toBeGreaterThan(20);
	});

	for (const file of corpus) {
		const rel = file.slice(file.indexOf("/json/") + "/json/".length);
		it(`no regression from #454: ${rel}`, () => {
			const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
			const { schemaVersion: _omit, ...stripped } = raw; // pre-#454 shape: no schemaVersion key

			const before = WorkflowIRSchema.safeParse(stripped); // pre-#454 shape
			const after = WorkflowIRSchema.safeParse(raw); // current shape

			// The whole point: adding schemaVersion must not flip any file's
			// parse verdict. Files that failed strict-parse before #454 (e.g.
			// empty.json `steps:[]`, middleware as a string array) still fail
			// for the SAME pre-existing reason — never because of schemaVersion.
			expect(after.success).toBe(before.success);

			// For files that DO parse, an absent schemaVersion must default to "2"
			// (v1/v2 JSON authors never wrote the field).
			if (before.success && raw.schemaVersion === undefined) {
				expect(before.data.schemaVersion).toBe("2");
			}
		});
	}
});
