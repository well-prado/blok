import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateWorkflow } from "../src/validateWorkflow";

/** Recursively collect every *.json path under `dir` (matches scanWorkflows). */
function walkJson(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkJson(full));
		else if (entry.name.endsWith(".json")) out.push(full);
	}
	return out;
}

// =============================================================================
// #305 — validateWorkflow: advisory, with explicit v1 detection.
// =============================================================================

describe("validateWorkflow — v2", () => {
	const valid = {
		name: "Fetch and Respond",
		version: "1.0.0",
		trigger: { http: { method: "GET" } },
		steps: [
			{ id: "fetch", use: "@blokjs/api-call", inputs: { url: "https://example.com" } },
			// js/... and $ expressions in inputs are valid strings — must NOT be flagged.
			{ id: "respond", use: "@blokjs/respond", inputs: { body: "js/ctx.state.fetch", id: "$.req.body.id" } },
		],
	};

	it("returns ok:true / kind:v2 for a valid v2 workflow", () => {
		const r = validateWorkflow(valid);
		expect(r.ok).toBe(true);
		expect(r.kind).toBe("v2");
		expect(r.errors).toEqual([]);
	});

	it("does not flag js/... or $ expression strings in inputs", () => {
		expect(validateWorkflow(valid).ok).toBe(true);
	});

	it("accepts a middleware-only workflow with no trigger", () => {
		const r = validateWorkflow({
			name: "auth-check",
			version: "1.0.0",
			middleware: true,
			steps: [{ id: "check", use: "@blokjs/respond" }],
		});
		expect(r.ok).toBe(true);
		expect(r.kind).toBe("v2");
	});

	it("returns ok:false / kind:v2 with a path-bearing error for a missing step id", () => {
		const r = validateWorkflow({
			name: "bad",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [{ use: "@blokjs/respond" }],
		});
		expect(r.ok).toBe(false);
		expect(r.kind).toBe("v2");
		expect(r.errors.length).toBeGreaterThan(0);
		// Error points at the offending step index.
		expect(r.errors.some((e) => e.path.startsWith("steps.0"))).toBe(true);
	});

	it("rejects as + spread on the same step (path points at the step)", () => {
		const r = validateWorkflow({
			name: "bad",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [{ id: "x", use: "n", as: "out", spread: true }],
		});
		expect(r.ok).toBe(false);
		expect(r.errors.some((e) => /mutually exclusive/.test(e.message))).toBe(true);
		expect(r.errors.some((e) => e.path.startsWith("steps.0"))).toBe(true);
	});

	it("rejects empty steps[]", () => {
		const r = validateWorkflow({
			name: "empty",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [],
		});
		expect(r.ok).toBe(false);
		expect(r.kind).toBe("v2");
		expect(r.errors.some((e) => e.path === "steps")).toBe(true);
	});

	it("rejects an unsupported future schemaVersion with a path", () => {
		const r = validateWorkflow({
			schemaVersion: "3",
			name: "future",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [{ id: "x", use: "n" }],
		});
		expect(r.ok).toBe(false);
		expect(r.errors.some((e) => e.path === "schemaVersion")).toBe(true);
	});

	it("rejects an unknown strict step field (.strict) with the right path", () => {
		const r = validateWorkflow({
			name: "strict",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [{ id: "x", use: "n", bogus: true }],
		});
		expect(r.ok).toBe(false);
		expect(r.errors.some((e) => e.path.startsWith("steps.0") && /[Uu]nrecognized key/.test(e.message))).toBe(true);
	});

	it("locates an error inside a nested control-flow step's own config", () => {
		// The error path must point at the offending nested config field. (v2's
		// flow-control sub-pipelines are `z.array(z.unknown())` — they don't
		// recurse into the inner steps — but the flow step's OWN config is
		// validated, so an empty `try` array surfaces a precise path.)
		const r = validateWorkflow({
			name: "nested-bad",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [{ id: "outer", tryCatch: { try: [], catch: [{ id: "c", use: "n" }] } }],
		});
		expect(r.ok).toBe(false);
		expect(r.kind).toBe("v2");
		expect(r.errors.some((e) => e.path === "steps.0.tryCatch.try")).toBe(true);
	});
});

describe("validateWorkflow — v1 detection (advisory, not strict-reject)", () => {
	it("detects a top-level nodes{} map as legacy v1", () => {
		const r = validateWorkflow({
			name: "legacy",
			version: "1.0.0",
			steps: [{ name: "fetch", node: "@blokjs/api-call", type: "module" }],
			nodes: { fetch: { inputs: { url: "https://example.com" } } },
		});
		expect(r.ok).toBe(false);
		expect(r.kind).toBe("v1");
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0].message).toMatch(/legacy v1/i);
	});

	it("detects steps using .name/.node without .id/.use as legacy v1", () => {
		const r = validateWorkflow({
			name: "legacy",
			version: "1.0.0",
			steps: [{ name: "fetch", node: "@blokjs/api-call", type: "module" }],
		});
		expect(r.ok).toBe(false);
		expect(r.kind).toBe("v1");
		// A single clear message — NOT a wall of strict v2 issues.
		expect(r.errors).toHaveLength(1);
	});

	it("does NOT misclassify a valid v2 step (id+use) as v1", () => {
		const r = validateWorkflow({
			name: "valid-v2",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [{ id: "fetch", use: "@blokjs/api-call" }],
		});
		expect(r.kind).toBe("v2");
		expect(r.ok).toBe(true);
	});
});

describe("validateWorkflow — unknown / non-workflow inputs", () => {
	it("returns kind:unknown for non-objects", () => {
		for (const bad of [null, undefined, 42, "str", [], true]) {
			const r = validateWorkflow(bad as unknown);
			expect(r.ok).toBe(false);
			expect(r.kind).toBe("unknown");
		}
	});

	it("returns kind:unknown for an object with no steps and no nodes", () => {
		const r = validateWorkflow({ name: "x", version: "1.0.0" });
		expect(r.ok).toBe(false);
		expect(r.kind).toBe("unknown");
	});
});

// =============================================================================
// #306 — Corpus regression: prove validateWorkflow() does not reject anything
// that scanWorkflows currently loads-and-runs. Every JSON workflow in the repo
// is loaded-and-run today (scanWorkflows.ts does NOT Zod-validate on load), so
// each must be ok:true OR the distinct legacy verdict — anything else is a
// strict-vs-tolerant GAP that enforcing the validator on load would break.
//
// The gap is EXPECTED to be non-empty (it quantifies what enforcement costs);
// it is pinned to a known allowlist so a *new* regression (a previously-passing
// file starting to fail) breaks the build, while the documented gap does not.
// =============================================================================

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, "../../../triggers/http/workflows/json");

// Files that load-and-run today but DON'T pass strict v2 validation. Each is a
// concrete data point on what making the validator mandatory would break.
// Update this list (and the printed gap) deliberately — never to silence a new
// failure. Reason per file is documented inline.
const KNOWN_GAP: Record<string, string> = {
	// empty steps[] — v2 schema requires >= 1 step; normalizer tolerates it.
	"empty.json": "steps: [] (empty) — v2 requires >=1 step",
	// `middleware: ["jwt-auth", ...]` is a trigger-level middleware ARRAY; the
	// v2 `middleware` field is the literal `true` "this IS middleware" flag.
	// Different concept — the normalizer accepts the array form.
	"v05-admin-delete-user.json": "middleware is a string[] (trigger mw chain), not literal true",
	"v05-jwt-protected.json": "middleware is a string[] (trigger mw chain), not literal true",
	"v05-hello-with-mw.json": "middleware is a string[] (trigger mw chain), not literal true",
	"v05-redis-protected.json": "middleware is a string[] (trigger mw chain), not literal true",
	// Per-step `description` field — .strict() rejects it; normalizer ignores it.
	"v06-reliability-showcase.json": "steps carry a `description` field rejected by .strict()",
};

describe("validateWorkflow — JSON corpus regression (#306)", () => {
	// Full recursive corpus, keyed by repo-relative path (matches scanWorkflows,
	// which scans `workflows/json` recursively).
	const files = existsSync(corpusDir) ? walkJson(corpusDir).map((p) => relative(corpusDir, p)) : [];

	it("the corpus directory exists and is non-empty", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it("every loadable JSON workflow is ok:true, legacy, OR a documented gap (no unexplained ok:false)", () => {
		const unexplained: { file: string; errors: string }[] = [];
		const gapHit: string[] = [];

		for (const f of files) {
			const doc = JSON.parse(readFileSync(join(corpusDir, f), "utf8"));
			const r = validateWorkflow(doc);
			if (r.ok || r.kind === "v1") continue;
			if (f in KNOWN_GAP) {
				gapHit.push(f);
				continue;
			}
			unexplained.push({ file: f, errors: r.errors.map((e) => `${e.path}: ${e.message}`).join(" | ") });
		}

		// Quantify the strict-vs-tolerant gap (acceptance: printed + counted).
		console.log(
			`\n[validateWorkflow corpus] ${files.length} JSON workflows; ${gapHit.length} would BREAK if the validator were enforced on load:\n${gapHit.map((f) => `  - ${f}: ${KNOWN_GAP[f]}`).join("\n")}`,
		);

		if (unexplained.length > 0) {
			console.error(
				`\n[validateWorkflow corpus] UNEXPLAINED failures (regression vs what loads today):\n${unexplained.map((u) => `  - ${u.file}: ${u.errors}`).join("\n")}`,
			);
		}
		expect(unexplained).toEqual([]);
	});

	it("every documented-gap file still actually loads (fails v2 but is not v1/unknown)", () => {
		// Guards the allowlist against bit-rot: if a gap file is fixed upstream it
		// should be removed from KNOWN_GAP, surfaced here as a now-passing file.
		const nowPassing: string[] = [];
		for (const f of Object.keys(KNOWN_GAP)) {
			if (!files.includes(f)) continue; // file removed from corpus — ignore.
			const doc = JSON.parse(readFileSync(join(corpusDir, f), "utf8"));
			const r = validateWorkflow(doc);
			if (r.ok) nowPassing.push(f);
		}
		expect(nowPassing).toEqual([]);
	});
});
