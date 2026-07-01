import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKFLOW_IR_VERSION, WorkflowIRSchema, branch, workflow } from "../src/index";

/**
 * Issue #299 (TEST-ONLY) — prove PR #454 (added `schemaVersion` to
 * WorkflowV2Schema/WorkflowIRSchema, defaults "2", rejects "3") did not
 * regress the existing workflow corpus.
 *
 * Three halves:
 *  1. Schema-level default / round-trip / reject behaviour for `schemaVersion`.
 *  2. CORPUS REGRESSION — every real JSON workflow under
 *     triggers/http/workflows/json that is expected to be valid MUST still
 *     validate under the schemaVersion-carrying schema (a real regression net:
 *     it fails if a future schema change breaks an existing file). Files that
 *     fail strict-parse for pre-#454 reasons are pinned in QUARANTINE so the
 *     test also catches a change in WHY they fail.
 *  3. TS-COMPILED COVERAGE — `workflow({...})` envelopes (representative real
 *     workflows + inline constructions) have their `_config` validated too.
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
//
// The REAL invariant (not a tautology): every JSON workflow the repo ships and
// expects to be valid MUST keep validating under the schema that now carries
// `schemaVersion`. This is the regression net — it FAILS if a future schema
// change (a new required field, a tightened type, a renamed key) breaks an
// existing file. A handful of corpus files are KNOWN to fail strict-parse for
// reasons that predate #454 and are unrelated to schemaVersion; they're pinned
// in QUARANTINE with the exact issue path so the test also fails if one of them
// starts failing for a NEW reason (or starts passing — meaning the pin is stale).

const CORPUS_DIR = join(import.meta.dirname, "../../../triggers/http/workflows/json");

function walkJson(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		out.push(...(statSync(p).isDirectory() ? walkJson(p) : p.endsWith(".json") ? [p] : []));
	}
	return out;
}

const relPath = (file: string) => file.slice(file.indexOf("/json/") + "/json/".length);

// Files that fail strict-parse for a pre-existing, schemaVersion-unrelated
// reason → expected failing issue path. `empty.json` ships an empty `steps`
// (load-test fixture); the `middleware`-as-array files predate the
// `middleware: z.literal(true)` marker; `v06-reliability-showcase.json` exercises
// step keys not yet in V2StepSchema. Pin the issue path so a regression that
// changes WHY a file fails still trips the net.
const QUARANTINE: Record<string, string> = {
	"empty.json": "steps",
	"v05-admin-delete-user.json": "middleware",
	"v05-jwt-protected.json": "middleware",
	"v05-hello-with-mw.json": "middleware",
	"v05-redis-protected.json": "middleware",
	"v06-reliability-showcase.json": "steps.0",
};

const corpus = walkJson(CORPUS_DIR);

describe("schemaVersion — existing-workflow corpus regression (#299)", () => {
	it("enumerates a representative corpus of real JSON workflows", () => {
		// Guards against a silently-empty glob turning every per-file assertion
		// below into a no-op. The repo ships dozens of fixture workflows.
		expect(corpus.length).toBeGreaterThan(20);
	});

	it("quantifies the corpus split (valid v2 vs quarantined)", () => {
		let valid = 0;
		let quarantined = 0;
		for (const file of corpus) {
			const raw = JSON.parse(readFileSync(file, "utf8"));
			if (WorkflowIRSchema.safeParse(raw).success) valid++;
			else if (relPath(file) in QUARANTINE) quarantined++;
		}
		// The corpus is all v2-shaped JSON; the only non-validating files are the
		// pinned quarantine. Every other file is a passing v2 workflow.
		expect(valid).toBeGreaterThan(20);
		expect(valid + quarantined).toBe(corpus.length);
	});

	for (const file of corpus) {
		const rel = relPath(file);
		const quarantinedPath = QUARANTINE[rel];

		if (quarantinedPath !== undefined) {
			it(`quarantined (pre-#454 failure, not schemaVersion): ${rel}`, () => {
				const raw = JSON.parse(readFileSync(file, "utf8"));
				const parsed = WorkflowIRSchema.safeParse(raw);
				// Must still fail (a pin going green means it should leave quarantine)…
				expect(parsed.success).toBe(false);
				// …and fail for the SAME structural reason, never schemaVersion.
				if (!parsed.success) {
					const paths = parsed.error.issues.map((i) => i.path.join("."));
					expect(paths).toContain(quarantinedPath);
					expect(paths).not.toContain("schemaVersion");
				}
			});
			continue;
		}

		it(`validates under the schemaVersion-carrying schema: ${rel}`, () => {
			const raw = JSON.parse(readFileSync(file, "utf8"));
			const parsed = WorkflowIRSchema.safeParse(raw);
			// REAL regression net: this file is expected to be a valid v2 workflow.
			// A future schema change that breaks it fails HERE, not silently.
			expect(parsed.success).toBe(true);
			if (parsed.success) {
				// JSON authors never write schemaVersion → it must default to "2".
				expect(parsed.data.schemaVersion).toBe("2");
			}
		});
	}
});

// --- TS-compiled workflow coverage -------------------------------------------
//
// The corpus above is hand-authored JSON. The TS authoring path goes through
// the `workflow({...})` factory, which builds an `_config` envelope. Prove that
// envelope validates too — both for representative real workflows under
// triggers/http/src/workflows and for inline factory calls.

describe("schemaVersion — TS workflow() envelopes validate (#299)", () => {
	// Inline object-style `workflow({...})` shapes mirroring the real default
	// scaffold workflows (a plain step + branch variants). Kept INLINE rather
	// than imported from triggers/http: those TS scaffolds now use the
	// @blokjs/core typed-handle DSL, and importing them would pull the engine UP
	// into this base package's test env (helper sits below core). The real
	// scaffold files are covered by @blokjs/runner's scaffold-workflows test.
	const TS_SAMPLES: Array<readonly [string, { _config: unknown }]> = [
		["single-step", workflow({ ...base, name: "countries.list" })],
		[
			"branch-arms",
			workflow({
				...base,
				name: "countries.withCats",
				steps: [
					branch({
						id: "filter-request",
						when: 'ctx.request.query.countries === "true"',
						then: [{ id: "get-countries", use: "@blokjs/api-call", inputs: { url: "https://example.com/a" } }],
						else: [{ id: "get-facts", use: "@blokjs/api-call", inputs: { url: "https://example.com/b" } }],
					}),
				],
			}),
		],
		[
			"empty-branch",
			workflow({
				...base,
				name: "Empty",
				steps: [branch({ id: "filter-request", when: 'ctx.request.query.countries === "true"', then: [], else: [] })],
			}),
		],
	];

	for (const [name, wf] of TS_SAMPLES) {
		it(`${name} workflow() envelope validates`, () => {
			const parsed = WorkflowIRSchema.safeParse(wf._config);
			expect(parsed.success).toBe(true);
			if (parsed.success) expect(parsed.data.schemaVersion).toBe("2");
		});
	}

	it("inline workflow() envelopes validate and default schemaVersion to '2'", () => {
		const single = workflow({ ...base });
		const multi = workflow({
			...base,
			steps: [
				{ id: "a", use: "@blokjs/api-call", inputs: { url: "https://example.com" } },
				{ id: "b", use: "@blokjs/respond", inputs: { body: "$.state.a" } },
			],
		});
		for (const wf of [single, multi]) {
			const parsed = WorkflowIRSchema.safeParse(wf._config);
			expect(parsed.success).toBe(true);
			if (parsed.success) expect(parsed.data.schemaVersion).toBe("2");
		}
	});
});
