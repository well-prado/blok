// Pkl is how workflows are written. This file does the two things that connect it to the runner:
// it generates a typed Pkl step for every node and every workflow, and it evaluates workflow files into JSON.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type JsonSchema, type Unit, type Workflow, type WorkflowShape, contract } from "@blokjs/kernel";

const KEYWORDS = new Set(
	"abstract amends as case class const delete else extends external false fixed for function hidden if import in is let local module new nothing null open out outer override protected read record super switch this throw trace true typealias unknown vararg when".split(
		" ",
	),
);
const ident = (key: string) => (KEYWORDS.has(key) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `\`${key}\`` : key);
export const pascal = (text: string) => text.replace(/(^|-)([a-z0-9])/g, (_, __, char: string) => char.toUpperCase());

const KIND: Record<string, { input: string; ref: string }> = {
	string: { input: "Workflow.StringIn", ref: "Workflow.StringRef" },
	integer: { input: "Workflow.IntIn", ref: "Workflow.IntRef" },
	number: { input: "Workflow.NumberIn", ref: "Workflow.NumberRef" },
	boolean: { input: "Workflow.BoolIn", ref: "Workflow.BoolRef" },
	array: { input: "Workflow.ListIn", ref: "Workflow.ListRef" },
	object: { input: "Workflow.ObjectIn", ref: "Workflow.ObjectRef" },
};

function inputType(schema: JsonSchema, required: boolean): string {
	let type = KIND[String(schema.type)]?.input ?? "Any";
	if (schema.enum?.every((value) => typeof value === "string")) {
		const literals = schema.enum.map((value) => JSON.stringify(value)).join("|");
		type = `${literals}|Workflow.StringRef|Workflow.AnyRef|Workflow.Placeholder`;
	}
	if (required) return type;
	return type === "Any" ? "Any?" : `(${type})?`;
}

/** Everything a typed step class is generated from. */
export interface StepClass {
	/** The Pkl class name, such as `ChargeCard`. */
	name: string;
	/** The unit the step runs, such as `billing/charge-card@1`. */
	id: string;
	description?: string;
	input?: JsonSchema;
	output?: JsonSchema;
}

function block(step: StepClass): string {
	const inputs = Object.entries(step.input?.properties ?? {}).map(
		([key, schema]) => `  ${ident(key)}: ${inputType(schema, (step.input?.required ?? []).includes(key))}`,
	);
	const outputs = Object.entries(step.output?.properties ?? {}).map(
		([key, schema]) =>
			`  ${ident(key)}: ${KIND[String(schema.type)]?.ref ?? "Workflow.AnyRef"} = new { path = "\\(step).${key}" }`,
	);
	return [
		`/// ${(step.description ?? step.id).replace(/\s+/g, " ")}`,
		`class ${step.name} extends Workflow.Step {`,
		`  node = ${JSON.stringify(step.id)}`,
		...(inputs.length > 0 ? [`  inputs: ${step.name}Inputs`] : []),
		"  /// Typed pointers to this step's result fields.",
		`  hidden outputs: ${step.name}Outputs = new { step = outer.name }`,
		"}",
		...(inputs.length > 0 ? ["", `class ${step.name}Inputs {`, ...inputs, "}"] : []),
		"",
		`class ${step.name}Outputs {`,
		"  hidden step: String",
		...outputs,
		"}",
	].join("\n");
}

/** One generated Pkl file of typed steps. */
export interface StepsFile {
	/** Where it goes inside `workflows/blok/`, such as `orders.pkl`. */
	file: string;
	content: string;
}

function render(file: string, about: string, steps: StepClass[]): StepsFile {
	const parts = file.slice(0, -".pkl".length).split("/");
	const header = [
		`/// ${about} Do not edit.`,
		`module blok.${parts.map(ident).join(".")}`,
		"",
		// Workflow.pkl is at the top of the generated folder, and a module inside a module is one folder down.
		`import "${"../".repeat(parts.length - 1)}Workflow.pkl"`,
		"",
	].join("\n");
	return { file, content: `${header}\n${steps.map(block).join("\n\n")}${steps.length > 0 ? "\n" : ""}` };
}

/** `user-accounts` is `userAccounts` in Pkl, where a hyphen cannot be part of a name. */
const camel = (text: string) => text.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());

/**
 * How a node is written in a workflow: `billing/charge-card@2` is `billing.ChargeCardV2`, from `blok/billing.pkl`.
 * The name depends on the node alone, so adding another node never changes it.
 */
export function stepName(id: string): { import: string; step: string } {
	const [path, version] = id.split("@");
	const parts = path.split("/");
	const module = parts.slice(0, -1).map(camel);
	const cls = pascal(parts.at(-1) as string) + (version === "1" ? "" : `V${version}`);
	return { import: `blok/${module.join("/")}.pkl`, step: `${module.at(-1)}.${cls}` };
}

/**
 * One file of typed steps per node module: `nodes/orders/` becomes `orders.pkl`, and a workflow writes
 * `orders.ValidateOrder`. Each class holds the node's inputs by name and kind, and typed pointers to its result fields.
 */
export function nodeSteps(units: Iterable<Unit>): StepsFile[] {
	const files = new Map<string, { folder: string; steps: StepClass[] }>();
	for (const unit of [...units].filter((unit) => unit.kind === "node").sort((a, b) => a.id.localeCompare(b.id))) {
		const described = contract(unit);
		const name = stepName(unit.id);
		const file = name.import.slice("blok/".length);
		const entry = files.get(file) ?? { folder: unit.id.slice(0, unit.id.lastIndexOf("/")), steps: [] };
		entry.steps.push({
			name: name.step.slice(name.step.indexOf(".") + 1),
			id: unit.id,
			description: described.description,
			input: described.input as JsonSchema,
			output: described.output as JsonSchema,
		});
		files.set(file, entry);
	}
	return [...files].map(([file, { folder, steps }]) =>
		render(file, `A typed step for every node in nodes/${folder}/. GENERATED from the node contracts.`, steps),
	);
}

/** The class a workflow file gets in `workflows.pkl`: `place-order.pkl` is `workflows.PlaceOrder`. */
export const workflowClass = (name: string) => pascal(name);

/** `workflows.pkl`: one typed step per workflow whose shape is known, for using one workflow as a step in another. */
export function workflowSteps(
	known: Array<{ id: string; name: string; workflow: Workflow }>,
	shapes: ReadonlyMap<string, WorkflowShape>,
): { classes: Set<string>; file: StepsFile } {
	const steps = known
		.filter((entry) => shapes.has(entry.id))
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((entry) => ({
			name: workflowClass(entry.name),
			id: entry.id,
			description: entry.workflow.description ?? entry.workflow.name,
			input: shapes.get(entry.id)?.input,
			output: shapes.get(entry.id)?.output,
		}));
	const about =
		"A typed step for every workflow, for using one workflow as a step in another. GENERATED from what each workflow reads and answers with.";
	return { classes: new Set(steps.map((step) => step.name)), file: render("workflows.pkl", about, steps) };
}

/** The workflow classes a Pkl file mentions, so a workflow can be evaluated after the ones it uses as steps. */
export function classesUsed(source: string): Set<string> {
	return new Set([...source.matchAll(/\bworkflows\.([A-Z][A-Za-z0-9_]*)/g)].map((match) => match[1]));
}

/**
 * Evaluates Pkl workflow files into the JSON the runner loads, in one run of the `pkl` command.
 * A mistake in a file comes back as Pkl's own error, with the file and the line.
 */
export function evaluate(pkl: string, files: string[]): { workflows: Map<string, Workflow> } | { error: string } {
	const out = mkdtempSync(join(tmpdir(), "blok-workflows-"));
	try {
		const run = spawnSync(pkl, ["eval", "-f", "json", "-o", join(out, "%{moduleName}.json"), ...files], {
			encoding: "utf8",
		});
		if (run.error) return { error: `The Pkl command at "${pkl}" could not be run: ${run.error.message}` };
		if (run.status !== 0) return { error: run.stderr.trim() };
		const workflows = new Map<string, Workflow>();
		for (const file of files) {
			const name = basename(file, ".pkl");
			workflows.set(file, JSON.parse(readFileSync(join(out, `${name}.json`), "utf8")) as Workflow);
		}
		return { workflows };
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}
