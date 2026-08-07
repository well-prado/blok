import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RefCheckResult, checkWorkflowRefs, formatRefReport, loadCatalog } from "./refs.js";

// #691 — `blokctl check` gates workflow step-output references on the producing
// node's declared output schema. The headline fixture is the field report's own
// bug: a workflow mapping to a field the node never declares.

const tmpDirs: string[] = [];

afterEach(async () => {
	for (const dir of tmpDirs.splice(0)) await fsp.rm(dir, { recursive: true, force: true });
});

async function project(workflows: Record<string, unknown>): Promise<string> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "blok-check-refs-"));
	tmpDirs.push(dir);
	await fsp.mkdir(path.join(dir, "workflows", "json"), { recursive: true });
	for (const [name, doc] of Object.entries(workflows)) {
		await fsp.writeFile(path.join(dir, "workflows", "json", `${name}.json`), JSON.stringify(doc, null, 2), "utf8");
	}
	return dir;
}

/** The producing node's output schema, WITHOUT `readModelServed`. */
const projectorSchema = (extraField: boolean) => ({
	type: "object",
	properties: {
		eventsApplied: { type: "number" },
		lastSeq: { type: "number" },
		...(extraField ? { readModelServed: { type: "boolean" } } : {}),
	},
	required: ["eventsApplied", "lastSeq"],
	additionalProperties: false,
});

const catalog = (extraField: boolean) => [
	{ name: "projector", ref: "projector", outputSchema: projectorSchema(extraField) },
	{
		name: "@blokjs/respond",
		ref: "@blokjs/respond",
		outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, additionalProperties: false },
	},
];

const fieldReportWorkflow = {
	name: "ingest",
	version: "1.0.0",
	trigger: { http: { method: "POST", path: "/ingest" } },
	steps: [
		{ id: "project", use: "projector", inputs: { event: "x" } },
		{
			id: "respond",
			use: "@blokjs/respond",
			inputs: { body: { served: { $ref: { step: "project", path: ["readModelServed"] } } } },
		},
	],
};

const errorsOf = (r: RefCheckResult) =>
	r.reports.flatMap((rep) => rep.diagnostics.filter((d) => d.severity === "error"));

describe("blokctl check — the field-report scenario", () => {
	it("fails when the workflow maps to a field the node's output schema omits", async () => {
		const dir = await project({ ingest: fieldReportWorkflow });
		const result = await checkWorkflowRefs(dir, catalog(false));

		expect(result.errorCount).toBe(1);
		const [bad] = errorsOf(result);
		expect(bad?.code).toBe("unknown-field");
		expect(bad?.message).toContain("readModelServed");
		expect(bad?.message).toContain("eventsApplied, lastSeq");
		// The exit code the CLI derives from this is non-zero.
		expect(result.errorCount > 0).toBe(true);
	});

	it("passes once the field is added to the node's output schema", async () => {
		const dir = await project({ ingest: fieldReportWorkflow });
		const result = await checkWorkflowRefs(dir, catalog(true));
		expect(result.errorCount).toBe(0);
		expect(result.workflowCount).toBe(1);
	});
});

describe("blokctl check — graceful degradation", () => {
	it("reports zero errors and an unchecked count when no catalog is available", async () => {
		const dir = await project({ ingest: fieldReportWorkflow });
		const result = await checkWorkflowRefs(dir, null);

		expect(result.errorCount).toBe(0);
		expect(result.schemaless).toBe(true);
		expect(result.uncheckedStepCount).toBe(2);
		expect(formatRefReport(result, dir)).toContain("2 step(s) unchecked");
	});

	it("still reports dangling roots without any schema — those need none", async () => {
		const dir = await project({
			broken: {
				name: "broken",
				version: "1.0.0",
				trigger: { http: { method: "GET", path: "/x" } },
				steps: [{ id: "a", use: "mystery", inputs: { v: "js/ctx.state.nope.field" } }],
			},
		});
		const result = await checkWorkflowRefs(dir, null);
		expect(result.errorCount).toBe(1);
		expect(errorsOf(result)[0]?.code).toBe("dangling-step");
	});

	it("does not flag state written by a middleware workflow in the same project", async () => {
		const dir = await project({
			"auth-check": {
				name: "auth-check",
				version: "1.0.0",
				middleware: true,
				steps: [{ id: "stash", use: "@blokjs/ctx-publish", inputs: { name: "identity", value: { token: "t" } } }],
			},
			guarded: {
				name: "guarded",
				version: "1.0.0",
				trigger: { http: { method: "GET", path: "/g" } },
				steps: [{ id: "respond", use: "@blokjs/expr", inputs: { expression: "({ id: ctx.state.identity })" } }],
			},
		});
		const result = await checkWorkflowRefs(dir, null);
		expect(result.errorCount).toBe(0);
	});
});

describe("blokctl check — catalog loading", () => {
	it("accepts both the bare array and the `{nodes: [...]}` envelope", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "blok-catalog-"));
		tmpDirs.push(dir);
		const bare = path.join(dir, "bare.json");
		const wrapped = path.join(dir, "wrapped.json");
		await fsp.writeFile(bare, JSON.stringify(catalog(true)), "utf8");
		await fsp.writeFile(wrapped, JSON.stringify({ nodes: catalog(true) }), "utf8");

		expect(await loadCatalog({ nodes: bare })).toHaveLength(2);
		expect(await loadCatalog({ nodes: wrapped })).toHaveLength(2);
	});

	it("throws a clear error on a file that is not a catalog", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "blok-catalog-"));
		tmpDirs.push(dir);
		const bad = path.join(dir, "bad.json");
		await fsp.writeFile(bad, JSON.stringify({ hello: "world" }), "utf8");
		await expect(loadCatalog({ nodes: bad })).rejects.toThrow(/not a node catalog/);
	});

	it("returns null when neither --nodes nor --url is given", async () => {
		expect(await loadCatalog({})).toBeNull();
	});
});
