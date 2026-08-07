import type { Dirent } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import {
	type CatalogNodeLike,
	type RefDiagnostic,
	middlewareStateKeys,
	nodeSchemaLookup,
	validateRefs,
} from "@blokjs/helper";
import color from "picocolors";
import { fetchCatalog } from "../nodes/listNodes.js";

/**
 * `blokctl check` — schema-aware step-output reference checking (#691).
 *
 * Every `{$ref}` / `ctx.state.…` read in a JSON workflow is validated against
 * the declared output schema of the node behind the producing step, so a
 * mapping to a field the node never declares fails the build instead of
 * shipping a silent `null`.
 *
 * TS workflows are NOT scanned: the typed-handle DSL already gives `tsc` the
 * same guarantee at compile time, and blokctl cannot import a project's
 * TypeScript sources. This command covers exactly the surfaces `tsc` cannot
 * see — JSON, Studio-authored, AI-generated.
 *
 * Node schemas come from a running server's catalog (`--url`) or a saved
 * catalog file (`--nodes`, e.g. `blokctl nodes list --json > nodes.json` in
 * CI). With neither, every step is "unchecked": root-level problems are still
 * reported, field checking degrades to a count, and the command stays useful
 * rather than noisy.
 */

export interface WorkflowRefReport {
	readonly file: string;
	readonly workflow: string;
	readonly diagnostics: readonly RefDiagnostic[];
	readonly uncheckedSteps: readonly string[];
}

export interface RefCheckResult {
	readonly reports: readonly WorkflowRefReport[];
	readonly errorCount: number;
	readonly warningCount: number;
	readonly workflowCount: number;
	readonly uncheckedStepCount: number;
	/** True when no node schemas were available at all. */
	readonly schemaless: boolean;
}

/** Recursively collect `*.json` files under `dir`. Missing dir → `[]`. */
async function collectJsonFiles(dir: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await fsp.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await collectJsonFiles(full)));
		else if (entry.name.endsWith(".json")) out.push(full);
	}
	return out.sort();
}

/** Load the node catalog from `--nodes <file>` or a live server (`--url`). */
export async function loadCatalog(opts: {
	nodes?: string;
	url?: string;
}): Promise<CatalogNodeLike[] | null> {
	if (opts.nodes) {
		const raw = await fsp.readFile(opts.nodes, "utf8");
		const parsed: unknown = JSON.parse(raw);
		// Accept both `blokctl nodes list --json` (a bare array) and the raw
		// `GET /__blok/nodes` envelope.
		if (Array.isArray(parsed)) return parsed as CatalogNodeLike[];
		if (parsed && typeof parsed === "object" && Array.isArray((parsed as { nodes?: unknown }).nodes)) {
			return (parsed as { nodes: CatalogNodeLike[] }).nodes;
		}
		throw new Error(`${opts.nodes} is not a node catalog (expected an array, or an object with a "nodes" array).`);
	}
	if (opts.url) return await fetchCatalog(opts.url);
	return null;
}

/**
 * Validate every JSON workflow under `dir`. Pure of process concerns (no
 * printing, no `process.exit`) so it is unit-testable against a temp project.
 */
export async function checkWorkflowRefs(
	dir: string,
	catalog: readonly CatalogNodeLike[] | null,
): Promise<RefCheckResult> {
	const roots = [
		path.resolve(process.env.WORKFLOWS_PATH ?? path.join(dir, "workflows")),
		path.join(dir, "src", "workflows"),
	];
	const files: string[] = [];
	for (const root of roots) files.push(...(await collectJsonFiles(root)));

	const docs = new Map<string, unknown>();
	for (const file of [...new Set(files)]) {
		try {
			docs.set(file, JSON.parse(await fsp.readFile(file, "utf8")));
		} catch {
			// Not parseable — `validateWorkflow` is the surface that reports that.
		}
	}

	const lookup = catalog ? nodeSchemaLookup(catalog) : undefined;
	// Middleware runs on the guarded workflow's ctx, so its state keys are
	// legitimately readable from workflows that never write them.
	const knownStateKeys = middlewareStateKeys(docs.values());

	const reports: WorkflowRefReport[] = [];
	let errorCount = 0;
	let warningCount = 0;
	let uncheckedStepCount = 0;
	for (const [file, doc] of docs) {
		if (!doc || typeof doc !== "object" || !Array.isArray((doc as { steps?: unknown }).steps)) continue;
		const result = validateRefs(doc, { nodes: lookup, knownStateKeys });
		for (const d of result.diagnostics) {
			if (d.severity === "error") errorCount++;
			else warningCount++;
		}
		uncheckedStepCount += result.uncheckedSteps.length;
		reports.push({
			file,
			workflow: String((doc as { name?: unknown }).name ?? path.basename(file)),
			diagnostics: result.diagnostics,
			uncheckedSteps: result.uncheckedSteps,
		});
	}

	return {
		reports,
		errorCount,
		warningCount,
		workflowCount: reports.length,
		uncheckedStepCount,
		schemaless: !catalog || catalog.length === 0,
	};
}

/** Human-readable report. Warnings are collapsed so the output stays scannable. */
export function formatRefReport(result: RefCheckResult, cwd: string): string {
	const lines: string[] = [];
	for (const report of result.reports) {
		const errors = report.diagnostics.filter((d) => d.severity === "error");
		const warnings = report.diagnostics.filter((d) => d.severity === "warning");
		if (errors.length === 0 && warnings.length === 0) continue;
		lines.push(`  ${color.bold(path.relative(cwd, report.file))}`);
		for (const d of errors) {
			lines.push(`    ${color.red("✗")} ${color.dim(d.path)}  ${color.dim(`[${d.code}]`)}`);
			for (const line of d.message.split("\n")) lines.push(`      ${line}`);
		}
		if (warnings.length > 0) {
			// One line per warning: they never fail the build, so detail is noise.
			for (const d of warnings) {
				lines.push(`    ${color.yellow("!")} ${color.dim(d.path)}  ${d.message.split("\n")[0]}`);
			}
		}
		lines.push("");
	}

	const summary: string[] = [];
	summary.push(
		`  ${result.workflowCount} JSON workflow(s) checked — ${result.errorCount} error(s), ${result.warningCount} warning(s).`,
	);
	if (result.uncheckedStepCount > 0) {
		const how = result.schemaless
			? "Pass --url <baseUrl> (running server) or --nodes <catalog.json> to enable field checking."
			: "(ADR 0010).";
		summary.push(color.dim(`  ${result.uncheckedStepCount} step(s) unchecked — no output schema advertised. ${how}`));
	}
	return [...lines, ...summary].join("\n");
}
