import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { workflow } from "../src/components/workflowV2";
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

	// #700 — `middleware` is type-overloaded in the IR: `true` is the marker,
	// `string[]` is the v0.5.2 workflow-level chain (Configuration.appliedMiddleware
	// → TriggerBase.applyMiddlewareChain). The schema now declares both.
	it("accepts a workflow-level middleware CHAIN (`middleware: string[]`)", () => {
		const r = validateWorkflow({
			name: "guarded",
			version: "1.0.0",
			middleware: ["jwt-auth", "audit-log"],
			trigger: { http: { method: "GET" } },
			steps: [{ id: "respond", use: "@blokjs/respond" }],
		});
		expect(r.ok).toBe(true);
		expect(r.kind).toBe("v2");
	});

	it("rejects a middleware chain that isn't `true` or a list of non-empty names", () => {
		for (const bad of [false, "jwt-auth", [""], [1], {}]) {
			const r = validateWorkflow({
				name: "guarded",
				version: "1.0.0",
				middleware: bad,
				trigger: { http: { method: "GET" } },
				steps: [{ id: "respond", use: "@blokjs/respond" }],
			});
			expect(r.ok).toBe(false);
			expect(r.errors.some((e) => e.path.startsWith("middleware"))).toBe(true);
		}
	});

	// #700 — a per-step `description` is documentation the runner ignores;
	// `.strict()` used to reject it on every one of the 8 step shapes.
	it("accepts an optional `description` on all 8 step shapes", () => {
		const r = validateWorkflow({
			name: "documented",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [
				{ id: "regular", use: "n", description: "calls a node" },
				{ id: "branch", description: "forks", branch: { when: "ctx.x", then: [{ id: "a", use: "n" }] } },
				{ id: "sub", description: "calls a child", subworkflow: "child" },
				{ id: "wait", description: "pauses", wait: { for: "1s" } },
				{ id: "each", description: "iterates", forEach: { in: "js/ctx.state.items", as: "item", do: [{}] } },
				{ id: "loop", description: "polls", loop: { while: "ctx.x", do: [{}] } },
				{ id: "switch", description: "routes", switch: { on: "js/ctx.x", cases: [{ when: "a", do: [{}] }] } },
				{ id: "try", description: "guards", tryCatch: { try: [{}], catch: [{}] } },
			],
		});
		expect(r.errors).toEqual([]);
		expect(r.ok).toBe(true);
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

describe("validateWorkflow — TS-compiled builder envelope (#466)", () => {
	it("unwraps a `workflow()` builder envelope and returns ok:true / kind:v2", () => {
		const built = workflow({
			name: "Fetch and Respond",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [{ id: "fetch", use: "@blokjs/api-call", inputs: { url: "https://example.com" } }],
		});
		// Sanity: this is the raw envelope, not a plain config.
		expect((built as { _blokV2?: boolean })._blokV2).toBe(true);

		const r = validateWorkflow(built);
		expect(r.ok).toBe(true);
		expect(r.kind).toBe("v2");
		expect(r.errors).toEqual([]);
	});

	it("validates the inner config of a builder envelope — malformed steps surface as ok:false / kind:v2", () => {
		// Hand-built envelope (the `workflow()` helper would reject this at compile
		// time) carrying a step missing both id and use.
		const r = validateWorkflow({
			_blokV2: true,
			_config: {
				name: "bad",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [{ inputs: { url: "x" } }],
			},
		});
		expect(r.ok).toBe(false);
		expect(r.kind).toBe("v2");
		expect(r.errors.length).toBeGreaterThan(0);
		expect(r.errors.some((e) => e.path.startsWith("steps.0"))).toBe(true);
	});

	it("classifies a malformed builder envelope (missing _config) as unknown, not v2", () => {
		// `_blokV2: true` but no usable `_config` — the wrapper has no steps/nodes
		// of its own, so it isn't workflow-shaped.
		const r = validateWorkflow({ _blokV2: true });
		expect(r.ok).toBe(false);
		expect(r.kind).toBe("unknown");
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

	it("prefers kind:v2 when steps use id/use even if a stray nodes{} map is present (#466 LOW)", () => {
		// v2 steps + a leftover top-level nodes{} map → genuine v2; the stray map
		// is surfaced by the strict schema, NOT masked as a legacy verdict.
		const r = validateWorkflow({
			name: "v2-with-stray-nodes",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [{ id: "fetch", use: "@blokjs/api-call" }],
			nodes: { fetch: { inputs: { url: "https://example.com" } } },
		});
		expect(r.kind).toBe("v2");
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
// #700 — the gap is now EMPTY. `KNOWN_GAP` stays as a permanent TRIPWIRE: a new
// entry means a NEW divergence between the published schema and the IR the
// runtime accepts, and it must be closed on one side (fix the schema, or fix the
// workflow) — never appended here to silence a failure.
// =============================================================================

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, "../../../triggers/http/workflows/json");

// Files that load-and-run today but DON'T pass strict v2 validation. MUST stay
// empty (#700). See the block comment above before you touch this.
const KNOWN_GAP: Record<string, string> = {};

// Deliberately-invalid fixtures → the schema path that MUST report them.
//
// These are NOT gaps: the runtime rejects them too, so there is no strict-vs-
// tolerant divergence. `empty.json` ships `steps: []` and exists precisely to
// prove a zero-step workflow fails — `Configuration.ts` throws "Workflow must
// have at least one step" and `tests/e2e/workflows/workflow-e2e.test.ts` asserts
// `GET /empty` → 500. It lives in the scanned corpus dir because that e2e route
// has to exist, so it is pinned here as an asserted negative instead.
const NEGATIVE_FIXTURES: Record<string, string> = {
	"empty.json": "steps",
};

describe("validateWorkflow — JSON corpus regression (#306)", () => {
	// Full recursive corpus, keyed by repo-relative path (matches scanWorkflows,
	// which scans `workflows/json` recursively).
	const files = existsSync(corpusDir) ? walkJson(corpusDir).map((p) => relative(corpusDir, p)) : [];

	it("the corpus directory exists and is non-empty", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it("every loadable JSON workflow is ok:true or legacy (no unexplained ok:false)", () => {
		const unexplained: { file: string; errors: string }[] = [];
		const gapHit: string[] = [];

		for (const f of files) {
			const doc = JSON.parse(readFileSync(join(corpusDir, f), "utf8"));
			const r = validateWorkflow(doc);
			if (r.ok || r.kind === "v1") continue;
			// Deliberate negatives are asserted (must fail, at a pinned path) below.
			if (f in NEGATIVE_FIXTURES) continue;
			if (f in KNOWN_GAP) {
				gapHit.push(f);
				continue;
			}
			unexplained.push({ file: f, errors: r.errors.map((e) => `${e.path}: ${e.message}`).join(" | ") });
		}

		// Quantify the strict-vs-tolerant gap (acceptance: printed + counted).
		console.log(
			`\n[validateWorkflow corpus] ${files.length} JSON workflows; ${gapHit.length} would BREAK if the validator were enforced on load:${gapHit.map((f) => `\n  - ${f}: ${KNOWN_GAP[f]}`).join("")}`,
		);

		if (unexplained.length > 0) {
			console.error(
				`\n[validateWorkflow corpus] UNEXPLAINED failures (regression vs what loads today):\n${unexplained.map((u) => `  - ${u.file}: ${u.errors}`).join("\n")}`,
			);
		}
		expect(unexplained).toEqual([]);
		expect(gapHit).toEqual([]);
	});

	it("KNOWN_GAP is empty — the published schema describes the IR the runtime accepts (#700)", () => {
		// The tripwire. A new entry is a NEW divergence: fix the schema or fix the
		// workflow, don't append here.
		expect(Object.keys(KNOWN_GAP)).toEqual([]);
	});

	it("deliberate negative fixtures still fail, at the pinned path", () => {
		// Guards against bit-rot in both directions: a fixture silently starting to
		// pass (the negative is no longer negative) or failing for a NEW reason.
		for (const [f, path] of Object.entries(NEGATIVE_FIXTURES)) {
			expect(files).toContain(f);
			const doc = JSON.parse(readFileSync(join(corpusDir, f), "utf8"));
			const r = validateWorkflow(doc);
			expect(r.ok).toBe(false);
			expect(r.kind).toBe("v2");
			expect(r.errors.map((e) => e.path)).toContain(path);
		}
	});
});
