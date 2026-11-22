// status and show: what is left to build, and one node or workflow in full.
import { relative } from "node:path";
import { type Entry, type JsonSchema, type Workflow, contract, toolName } from "@blokjs/kernel";
import { type Analysis, type Paths, nodeFolder } from "./analyze.ts";
import type { Report } from "./commands.ts";
import { stepName, workflowClass } from "./pkl.ts";
import { testFiles } from "./tests.ts";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shown = (paths: Paths, path: string) => relative(paths.root, path) || ".";

/** What starts a workflow, one phrase per trigger: "POST /orders", "cron 0 2 * * * (UTC)", "queue orders.paid", "tool place_order". */
export function startedBy(id: string, workflow: Workflow): string[] {
	const { http, cron, queue, mcp } = workflow.trigger ?? {};
	return [
		...(http ? [`${http.method} ${http.path}${http.signature ? ` (signed, ${http.signature.scheme})` : ""}`] : []),
		...(cron ? [`cron ${cron.schedule} (${cron.timezone ?? "UTC"})`] : []),
		...(queue ? [`queue ${queue.name}`] : []),
		...(mcp ? [`tool ${toolName(id, workflow)}`] : []),
	];
}

/** Every step in a workflow, branches included, as [step name, node id]. */
function steps(entries: Entry[] = []): Array<[string, string]> {
	return entries.flatMap((entry): Array<[string, string]> => {
		if ("conditions" in entry)
			return entry.conditions.flatMap((branch) => steps("else" in branch ? branch.else : branch.steps));
		if ("parallel" in entry) return steps(entry.parallel);
		if ("fail" in entry) return [];
		return [[entry.name, entry.node], ...steps(entry.onError ?? []), ...steps(entry.undo ?? [])];
	});
}

/** Which workflows use a unit, and as which step. */
export function usedBy(analysis: Analysis, id: string): Array<{ workflow: string; step: string }> {
	return analysis.workflows.flatMap((entry) =>
		steps(entry.workflow.steps)
			.filter(([, node]) => node === id)
			.map(([step]) => ({ workflow: entry.id, step })),
	);
}

/** `billing/charge-card` means its newest version. Returns nothing when there is no such node. */
export function resolveNode(analysis: Analysis, given: string): string | undefined {
	if (analysis.nodes.has(given)) return given;
	if (given.includes("@")) return undefined;
	const versions = [...analysis.nodes.keys()]
		.filter((id) => id.split("@")[0] === given)
		.sort((a, b) => Number(a.split("@")[1]) - Number(b.split("@")[1]));
	return versions.at(-1);
}

function nodeFacts(analysis: Analysis, paths: Paths, id: string) {
	const folder = nodeFolder(paths, id);
	return {
		id,
		folder: shown(paths, folder),
		pkl: stepName(id),
		empty: analysis.empty.includes(id),
		locked: analysis.locked.includes(id),
		tests: testFiles(folder).map((file) => shown(paths, file)),
		usedBy: usedBy(analysis, id),
	};
}

/** The work queue: which nodes still have no logic, and what else is missing before the app can ship. */
export function status(analysis: Analysis, paths: Paths): Report {
	const nodes = [...analysis.nodes.keys()].sort().map((id) => nodeFacts(analysis, paths, id));
	const empty = nodes.filter((node) => node.empty);
	const untested = nodes.filter((node) => !node.empty && node.tests.length === 0);
	const unlocked = nodes.filter((node) => !node.locked);
	const width = Math.max(0, ...empty.map((node) => node.id.length));

	const lines: string[] = [];
	if (nodes.length === 0) lines.push('There are no nodes yet. Run "blokctl new node <module>/<node>".');
	else if (empty.length === 0) lines.push(`All ${count(nodes.length, "node")} are written.`);
	else {
		lines.push(`${empty.length} of ${count(nodes.length, "node")} ${empty.length === 1 ? "is" : "are"} still empty:`);
		for (const node of empty) {
			const users = [...new Set(node.usedBy.map((use) => use.workflow.slice("workflows/".length).split("@")[0]))];
			lines.push(
				`  ${node.id.padEnd(width)}  ${node.folder}${users.length > 0 ? `  used by ${users.join(", ")}` : "  used by no workflow"}`,
			);
		}
	}
	if (untested.length > 0) {
		lines.push(
			`${count(untested.length, "written node has", "written nodes have")} no test: ${untested.map((node) => node.id).join(", ")}.`,
		);
	}
	if (unlocked.length === 0 && nodes.length > 0) lines.push("Every node's contract is locked.");
	if (unlocked.length > 0 && nodes.length > 0) {
		lines.push(
			`${count(unlocked.length, "node has", "nodes have")} no contract.json, so nothing stops ${unlocked.length === 1 ? "its" : "their"} contract from changing. Run "blokctl lock" when the contracts are settled.`,
		);
	}
	if (analysis.problems.length > 0) {
		lines.push(
			"",
			`${count(analysis.problems.length, "problem")}:`,
			...analysis.problems.map((problem) => `- ${problem}`),
		);
	}
	return {
		ok: analysis.problems.length === 0,
		text: lines.join("\n"),
		data: {
			ok: analysis.problems.length === 0,
			total: nodes.length,
			empty: empty.map((node) => node.id),
			untested: untested.map((node) => node.id),
			unlocked: unlocked.map((node) => node.id),
			nodes,
			problems: analysis.problems,
		},
	};
}

const meaning = (meanings: Record<string, string>, code: string) => (meanings[code] ? `  (${meanings[code]})` : "");

/** One line per field, with the kind of each: enough to wire it, with the full schema in `--json`. */
function fieldLines(shape: JsonSchema | undefined, indent: string): string[] {
	const entries = Object.entries(shape?.properties ?? {});
	if (entries.length === 0) return [`${indent}nothing`];
	return entries.map(([key, inner]) => {
		const kind = inner.enum ? inner.enum.map((value) => JSON.stringify(value)).join(" | ") : (inner.type ?? "any");
		const about = (inner as { description?: string }).description;
		return `${indent}${key}${(shape?.required ?? []).includes(key) ? "" : "?"}: ${kind}${about ? `  (${about})` : ""}`;
	});
}

/** One node or one workflow in full. */
export function show(analysis: Analysis, paths: Paths, given: string): Report {
	const workflow = analysis.workflows.find(
		(entry) => entry.id === given || entry.id.split("@")[0] === given || entry.name === given,
	);
	const id = resolveNode(analysis, given);
	if (id) {
		const unit = analysis.nodes.get(id);
		if (!unit) throw new Error(`${id} was resolved but is not loaded.`);
		const described = contract(unit);
		const facts = nodeFacts(analysis, paths, id);
		const lines = [
			`${id}${facts.empty ? "  (empty)" : ""}`,
			...(described.description ? [`  ${described.description}`] : []),
			`  folder:   ${facts.folder}`,
			`  as a step: ${facts.pkl.step}, after import "${facts.pkl.import}"`,
			`  contract: ${facts.locked ? "locked by contract.json" : "not locked"}`,
			"  takes:",
			...fieldLines(described.input as JsonSchema, "    "),
			"  answers:",
			...fieldLines(described.output as JsonSchema, "    "),
			...(described.errors.length === 0
				? ["  errors:   none"]
				: ["  errors:", ...described.errors.map((code) => `    ${code}${meaning(described.errorMeanings, code)}`)]),
			`  tests:    ${facts.tests.length > 0 ? facts.tests.join(", ") : "none"}`,
			`  used by:  ${
				facts.usedBy.length > 0
					? facts.usedBy.map((use) => `${use.workflow} (step "${use.step}")`).join(", ")
					: "no workflow"
			}`,
		];
		return { ok: true, text: lines.join("\n"), data: { ok: true, ...described, ...facts } };
	}
	if (workflow) {
		const shape = analysis.shapes.get(workflow.id);
		const http = workflow.workflow.trigger?.http;
		const starts = startedBy(workflow.id, workflow.workflow);
		const lines = [
			workflow.id,
			...(workflow.workflow.description ? [`  ${workflow.workflow.description}`] : []),
			`  started by: ${starts.length > 0 ? starts.join(", ") : "nothing from outside. It is a step in other workflows"}`,
			`  file:      ${shown(paths, `${paths.workflows}/${workflow.file}`)}`,
			`  as a step: workflows.${workflowClass(workflow.name)}, after import "blok/workflows.pkl"`,
			...["body", "query", "params", "headers"].flatMap((part) => {
				const read = shape?.request.properties?.[part];
				return read?.properties ? [`  reads ${part}:`, ...fieldLines(read, "    ")] : [];
			}),
			"  answers:",
			...(shape?.output?.properties ? fieldLines(shape.output, "    ") : [`    ${shape?.output?.type ?? "anything"}`]),
			"  steps:",
			...steps(workflow.workflow.steps).map(([step, node]) => `    ${step}: ${node}`),
			...(http?.errors
				? [
						`  statuses:  ${Object.entries(http.errors)
							.map(([code, status]) => `${code} is ${status}`)
							.join(", ")}`,
					]
				: []),
		];
		const data = {
			ok: true,
			kind: "workflow",
			id: workflow.id,
			file: workflow.file,
			pkl: { import: "blok/workflows.pkl", step: `workflows.${workflowClass(workflow.name)}` },
			startedBy: starts,
			request: shape?.request,
			answers: shape?.output,
			usedBy: usedBy(analysis, workflow.id),
			workflow: workflow.workflow,
		};
		return { ok: true, text: lines.join("\n"), data };
	}
	const text = `"${given}" is not a node or a workflow. Run "blokctl list" to see them.`;
	return { ok: false, text, data: { ok: false, problems: [text] } };
}
