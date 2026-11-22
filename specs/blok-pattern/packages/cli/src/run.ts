// run: one node or one workflow from the terminal, with the project's own ports.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BlokError, type Span, blok, loadWorkflows } from "@blokjs/kernel";
import type { Analysis, Paths } from "./analyze.ts";
import type { Report } from "./commands.ts";
import { resolveNode } from "./inspect.ts";

const fail = (text: string): Report => ({ ok: false, text, data: { ok: false, problems: [text] } });

/** The ports to run with: `--ports <file>`, or the `ports` the project exports from ports/index. */
async function loadPorts(paths: Paths, given?: string): Promise<unknown> {
	const candidates = given
		? [resolve(paths.root, given)]
		: ["ts", "js", "mts", "mjs"].map((ending) => join(paths.dir, "ports", `index.${ending}`));
	const file = candidates.find((candidate) => existsSync(candidate));
	if (!file)
		throw new Error(given ? `${given} does not exist.` : "There is no ports/index file to take the ports from.");
	const module = await import(pathToFileURL(file).href);
	const ports = module.ports ?? module.default;
	if (ports === undefined) {
		throw new Error(`${file} exports no \`ports\`. Export one, or pass a file that does with --ports.`);
	}
	return ports;
}

/**
 * Runs a node with the input given, or a workflow with the request given, and prints what it answers with.
 * A workflow's input is its request: {"body": {...}, "query": {...}, "params": {...}}.
 */
export async function run(
	analysis: Analysis,
	paths: Paths,
	given: string,
	options: { input?: string; ports?: string },
): Promise<Report> {
	if (analysis.problems.length > 0) {
		return fail(`This project has problems, so nothing was run:\n${analysis.problems.map((p) => `- ${p}`).join("\n")}`);
	}
	const units = new Map(analysis.nodes);
	loadWorkflows(analysis.workflows, units);
	// A workflow answers to its id, its id without the version, and its file name.
	const workflow = analysis.workflows.find(
		(entry) => entry.id === given || entry.id.split("@")[0] === given || entry.name === given,
	);
	const id = workflow?.id ?? resolveNode(analysis, given);
	const unit = id ? units.get(id) : undefined;
	if (!id || !unit) return fail(`"${given}" is not a node or a workflow. Run "blokctl list" to see them.`);

	let input: unknown;
	try {
		input = JSON.parse(options.input ?? "{}");
	} catch (err) {
		return fail(`--input is not valid JSON: ${(err as Error).message}`);
	}
	// A workflow reads its request. A server always hands it all four parts, so the same holds here.
	if (workflow && input !== null && typeof input === "object") {
		input = { body: {}, query: {}, params: {}, headers: {}, ...input };
	}
	let ports: unknown;
	try {
		ports = await loadPorts(paths, options.ports);
	} catch (err) {
		return fail((err as Error).message);
	}

	const spans: Span[] = [];
	const { call } = blok<unknown>().runtime({ ports, onSpan: (span) => spans.push(span) });
	const trace = () => spans.map((span) => ({ ...span, ms: Math.round(span.ms * 100) / 100 }));
	const traceText = () =>
		spans
			.map(
				(span) =>
					`  ${span.ok ? "ok " : "ERR"} ${span.id}${span.key ? ` (step "${span.key}")` : ""}  ${span.ms.toFixed(2)}ms${span.error ? `  ${span.error}` : ""}`,
			)
			.join("\n");
	try {
		const output = await call(unit, input);
		const text = `${JSON.stringify(output, null, 2)}\n\nWhat ran:\n${traceText()}`;
		return { ok: true, text, data: { ok: true, id, output, spans: trace() } };
	} catch (err) {
		const error =
			err instanceof BlokError
				? { code: err.code, message: err.message, node: err.node }
				: { code: "unexpected", message: err instanceof Error ? err.message : String(err), node: id };
		const text = `${id} failed with "${error.code}" at ${error.node}: ${error.message}\n\nWhat ran:\n${traceText()}`;
		return { ok: false, text, data: { ok: false, id, error, spans: trace() } };
	}
}
