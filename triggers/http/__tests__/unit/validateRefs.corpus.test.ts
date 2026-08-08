import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ApiCallNode from "@blokjs/api-call";
import { middlewareStateKeys, nodeSchemaLookup, validateRefs } from "@blokjs/helper";
import { HELPER_NODES } from "@blokjs/helpers";
import IfElseNode from "@blokjs/if-else";
import { describe, expect, it } from "vitest";

/**
 * #691 — full-corpus regression.
 *
 * The schema-aware ref pass runs against EVERY JSON workflow in the repo with
 * the real output schemas of the module nodes those workflows use. The bar is
 * zero errors: a validator that cries wolf on the project's own corpus is a
 * validator people switch off.
 *
 * The mutation probe at the end is what stops this from being a vacuous pass —
 * it proves the corpus is genuinely being checked, not silently skipped.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const CORPUS_DIRS = [
	"workflows/json",
	"examples/workflows",
	"examples/v05-primitives",
	// #728 — these three were already in the boot-time load gate
	// (`core/runner/__tests__/unit/workflow/corpusLoad.test.ts`, which scans
	// the whole `examples` tree) but missing here, so a JSON workflow shipped
	// under them would load fine yet never get the $ref-validity check.
	"examples/runtimes",
	"examples/templates",
	"examples/ts-workflows",
	"triggers/http/workflows",
	"triggers/grpc/workflows",
];

interface Reflectable {
	name?: string;
	getReflectionSchemas?: () => { input: unknown; output: unknown };
	getSchemas?: () => { input: unknown; output: unknown };
}

function catalogEntry(ref: string, node: unknown) {
	const n = node as Reflectable;
	const schemas =
		typeof n.getReflectionSchemas === "function"
			? n.getReflectionSchemas()
			: typeof n.getSchemas === "function"
				? n.getSchemas()
				: undefined;
	return { ref, name: n.name, outputSchema: schemas?.output };
}

const catalog = [
	...Object.entries(HELPER_NODES as Record<string, unknown>).map(([ref, node]) => catalogEntry(ref, node)),
	catalogEntry("@blokjs/api-call", ApiCallNode),
	catalogEntry("@blokjs/if-else", IfElseNode),
];

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

const docs = files
	.map((file) => {
		try {
			return { file, doc: JSON.parse(readFileSync(file, "utf8")) as unknown };
		} catch {
			return null;
		}
	})
	.filter((entry): entry is { file: string; doc: unknown } => entry !== null)
	.filter(({ doc }) => typeof doc === "object" && doc !== null && Array.isArray((doc as { steps?: unknown }).steps));

const lookup = nodeSchemaLookup(catalog);
const knownStateKeys = middlewareStateKeys(docs.map(({ doc }) => doc));

describe("validateRefs — in-repo workflow corpus (#691)", () => {
	it("finds a corpus to check", () => {
		expect(docs.length).toBeGreaterThan(50);
	});

	it("reports ZERO errors across every JSON workflow in the repo", () => {
		const failures: string[] = [];
		for (const { file, doc } of docs) {
			const result = validateRefs(doc, { nodes: lookup, knownStateKeys });
			for (const d of result.diagnostics) {
				if (d.severity !== "error") continue;
				failures.push(`${path.relative(REPO_ROOT, file)} → ${d.path} [${d.code}] ${d.message.split("\n")[0]}`);
			}
		}
		expect(failures, `\n${failures.join("\n")}\n`).toEqual([]);
	});

	it("DOES catch a field that the producing node's schema omits (the probe)", () => {
		const source = docs.find(({ file }) => file.endsWith("agent-message.json"));
		expect(source).toBeDefined();
		// `@blokjs/llm-agent` declares `fullText`; `notAField` it does not.
		const mutated: unknown = JSON.parse(
			JSON.stringify(source?.doc).replaceAll("ctx.state.agent.fullText", "ctx.state.agent.notAField"),
		);
		const result = validateRefs(mutated, { nodes: lookup, knownStateKeys });
		const errors = result.diagnostics.filter((d) => d.severity === "error");
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.every((d) => d.code === "unknown-field")).toBe(true);
	});
});
