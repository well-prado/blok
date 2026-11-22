// check, build and list. Each returns what to print and the same facts as data, for `--json`.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type JsonSchema, contract } from "@blokjs/kernel";
import { type Analysis, type Paths, analyze, nodeFolder } from "./analyze.ts";
import { resolveNode } from "./inspect.ts";
import type { PklOptions } from "./pkl-bin.ts";
import { stepName, workflowClass } from "./pkl.ts";
import { type TestRun, runTests, testFiles, typeErrors } from "./tests.ts";

export interface Report {
	ok: boolean;
	/** What a person reads. */
	text: string;
	/** The same facts for a program or an agent. */
	data: Record<string, unknown>;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function summary(analysis: Analysis) {
	return {
		nodes: analysis.nodes.size,
		workflows: analysis.workflows.length,
		empty: analysis.empty,
		problems: analysis.problems,
	};
}

function problemsText(problems: string[]): string {
	return `${count(problems.length, "problem")}:\n${problems.map((problem) => `- ${problem}`).join("\n")}`;
}

const emptyText = (empty: string[]) =>
	`${count(empty.length, "node is", "nodes are")} still empty: ${empty.join(", ")}.`;

export interface CheckOptions {
	/** One node: also require that it is written, that it has tests, and that they pass. */
	id?: string;
	/** Also run every node's tests. */
	tests?: boolean;
	pkl?: PklOptions;
}

/**
 * Does everything line up? With a node id it is the gate for one node: the whole project still lines up,
 * the node's contract is what was locked, its logic is written, and its tests pass.
 */
export async function check(paths: Paths, options: CheckOptions = {}): Promise<Report> {
	const analysis = await analyze(paths, options.pkl);
	const problems = [...analysis.problems];
	const data: Record<string, unknown> = { ok: false, ...summary(analysis), problems };

	const id = options.id ? resolveNode(analysis, options.id) : undefined;
	if (options.id && !id && analysis.problems.length === 0) {
		problems.push(`${options.id} is not a node. Run "blokctl list" to see the nodes.`);
	}
	let ran: TestRun | undefined;
	let typed = false;
	if (id) {
		data.id = id;
		const folder = nodeFolder(paths, id);
		const files = testFiles(folder);
		if (analysis.empty.includes(id)) problems.push(`${id} is still empty. Replace \`run: todo\` with its logic.`);
		if (files.length === 0) {
			problems.push(`${id} has no test. Write one beside it, in ${relative(paths.root, folder)}/node.test.ts.`);
		} else {
			ran = runTests(paths.root, files);
			if (!ran.ok) problems.push(`${id}: its tests fail. This is what "${ran.command}" printed:\n${ran.output}`);
		}
		// Most test runners run TypeScript without checking it, so a type error can hide behind passing tests.
		const types = typeErrors(paths.root, folder);
		typed = types.checked;
		data.types = { checked: types.checked, errors: types.errors.length };
		if (types.errors.length > 0) problems.push(`${id}: its code has type errors:\n${types.errors.join("\n")}`);
	} else if (options.tests && analysis.problems.length === 0) {
		const files = testFiles(paths.nodes);
		if (files.length > 0) {
			ran = runTests(paths.root, files);
			if (!ran.ok) problems.push(`The node tests fail. This is what "${ran.command}" printed:\n${ran.output}`);
		}
		const types = typeErrors(paths.root, paths.nodes);
		typed = types.checked;
		data.types = { checked: types.checked, errors: types.errors.length };
		if (types.errors.length > 0) problems.push(`The nodes have type errors:\n${types.errors.join("\n")}`);
	}
	if (ran) data.tests = { command: ran.command, passed: ran.ok, count: ran.passed };

	if (problems.length > 0) return { ok: false, text: problemsText(problems), data };
	data.ok = true;
	const lines = [
		`${count(analysis.nodes.size, "node")} and ${count(analysis.workflows.length, "workflow")} line up.`,
		...(id
			? [
					`${id} is done: ${[
						"its logic is written",
						ran?.passed ? `its ${count(ran.passed, "test passes", "tests pass")}` : "its tests pass",
						...(typed ? ["its types check"] : []),
						...(analysis.locked.includes(id) ? ["its contract is what contract.json promises"] : []),
					]
						.join(", ")
						.replace(/, ([^,]*)$/, " and $1")}.`,
				]
			: []),
		...(!id && ran
			? [
					`${ran.passed ? count(ran.passed, "node test passes", "node tests pass") : "The node tests pass"}${typed ? ", and the types check" : ""}.`,
				]
			: []),
		// For one node, the other nodes being empty is somebody else's job and would only read like a failure.
		...(!id && analysis.empty.length > 0 ? [emptyText(analysis.empty)] : []),
	];
	return { ok: true, text: lines.join("\n"), data };
}

/**
 * Checks, then writes the JSON production loads into `.blok/workflows/`.
 * A node that is still empty stops the build, unless `allowEmpty` is set, which is what `dev` does.
 */
export async function build(paths: Paths, options: { allowEmpty?: boolean; pkl?: PklOptions } = {}): Promise<Report> {
	const analysis = await analyze(paths, options.pkl);
	const data: Record<string, unknown> = { ok: false, ...summary(analysis) };
	if (analysis.problems.length > 0) return { ok: false, text: problemsText(analysis.problems), data };
	if (analysis.empty.length > 0 && !options.allowEmpty) {
		const text = `${emptyText(analysis.empty)}\nNothing was built. An empty node answers "not_implemented", so it cannot be shipped.`;
		return { ok: false, text, data };
	}

	mkdirSync(paths.built, { recursive: true });
	const wanted = new Map(
		analysis.workflows.map((entry) => [`${entry.name}.json`, `${JSON.stringify(entry.workflow, null, "\t")}\n`]),
	);
	for (const file of readdirSync(paths.built)) {
		if (file.endsWith(".json") && !wanted.has(file)) rmSync(join(paths.built, file));
	}
	for (const [file, content] of wanted) {
		let current: string | undefined;
		try {
			current = readFileSync(join(paths.built, file), "utf8");
		} catch {}
		if (current !== content) writeFileSync(join(paths.built, file), content);
	}
	const where = relative(process.cwd(), paths.built) || ".";
	const lines = [
		`Built ${count(analysis.workflows.length, "workflow")} into ${where}.`,
		...(analysis.empty.length > 0 ? [emptyText(analysis.empty)] : []),
	];
	return { ok: true, text: lines.join("\n"), data: { ...data, ok: true, built: where } };
}

const fields = (shape: JsonSchema | undefined): string => {
	const names = Object.entries(shape?.properties ?? {}).map(([key, inner]) => {
		const kind = typeof inner.type === "string" ? inner.type : "any";
		return `${key}${(shape?.required ?? []).includes(key) ? "" : "?"}: ${kind}`;
	});
	return names.length > 0 ? names.join(", ") : "nothing";
};

/** The catalog: every node and workflow, with what it takes and what it answers with. */
export function list(analysis: Analysis): Report {
	// `pkl` is how a workflow writes the node as a step, and the file it imports for that.
	const nodes = [...analysis.nodes.values()]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((unit) => ({ ...contract(unit), pkl: stepName(unit.id) }));
	const workflows = analysis.workflows.map((entry) => ({
		id: entry.id,
		file: entry.file,
		pkl: { import: "blok/workflows.pkl", step: `workflows.${workflowClass(entry.name)}` },
		name: entry.workflow.name,
		description: entry.workflow.description,
		trigger: entry.workflow.trigger,
		request: analysis.shapes.get(entry.id)?.request,
		answers: analysis.shapes.get(entry.id)?.output,
	}));

	const lines: string[] = [`Nodes (${nodes.length})`];
	for (const node of nodes) {
		lines.push(`  ${node.id}  as ${node.pkl.step}${node.implemented ? "" : "  (empty)"}`);
		if (node.description) lines.push(`    ${node.description}`);
		lines.push(`    takes:   ${fields(node.input as JsonSchema)}`);
		lines.push(`    answers: ${fields(node.output as JsonSchema)}`);
		if (node.errors.length > 0) lines.push(`    errors:  ${node.errors.join(", ")}`);
	}
	lines.push("", `Workflows (${workflows.length})`);
	for (const workflow of workflows) {
		const http = workflow.trigger?.http;
		lines.push(`  ${workflow.id}  as ${workflow.pkl.step}${http ? `  ${http.method} ${http.path}` : ""}`);
		if (workflow.description) lines.push(`    ${workflow.description}`);
		for (const part of ["body", "query", "params", "headers"]) {
			const shape = workflow.request?.properties?.[part];
			if (shape?.properties) lines.push(`    reads ${part}: ${fields(shape)}`);
		}
		const answers = workflow.answers;
		lines.push(`    answers: ${answers?.properties ? fields(answers) : (answers?.type ?? "anything")}`);
	}
	if (analysis.problems.length > 0) lines.push("", problemsText(analysis.problems));
	return {
		ok: analysis.problems.length === 0,
		text: lines.join("\n"),
		data: { ok: analysis.problems.length === 0, nodes, workflows, problems: analysis.problems },
	};
}
