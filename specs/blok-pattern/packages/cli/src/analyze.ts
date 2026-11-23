// Reads a whole project and says what is wrong with it. `check`, `build`, `list` and `dev` all start here.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Entry,
	type Unit,
	type Workflow,
	type WorkflowShape,
	checkWorkflows,
	discoverNodes,
	isTodo,
	workflowId,
} from "@blokjs/kernel";
import { Ajv2020 } from "ajv/dist/2020.js";
import { type Language, languageOf, pyprojectSettings } from "./language.ts";
import { LOCK_FILE, type Locked, drift, readLock } from "./lock.ts";
import { type PklOptions, findPkl } from "./pkl-bin.ts";
import { type StepsFile, classesUsed, evaluate, nodeSteps, workflowClass, workflowSteps } from "./pkl.ts";
import { pythonNodes } from "./python.ts";
import { assetText } from "./standalone.ts";

/** A file that ships with this tool. The single-file build carries them inside itself. */
const asset = (name: string) =>
	assetText(name) ?? readFileSync(fileURLToPath(new URL(`../assets/${name}`, import.meta.url)), "utf8");

export interface Paths {
	/** Where the command was run: the folder with package.json or pyproject.toml. */
	root: string;
	/** The language the nodes are written in. */
	language: Language;
	/** The folder that holds `nodes/` and `workflows/`. */
	dir: string;
	nodes: string;
	workflows: string;
	/** `workflows/blok/`: the Pkl files this tool writes. */
	generated: string;
	/** `.blok/workflows/`: the JSON production loads. */
	built: string;
}

/**
 * The project folder: `--dir`, or `"blok": { "dir": "src" }` in package.json, or `dir = "src"` under
 * [tool.blok] in pyproject.toml, or where the command was run.
 */
export function locate(cwd: string, flag?: string): Paths {
	const language = languageOf(cwd);
	let configured: string | undefined;
	if (language.name === "python") configured = pyprojectSettings(cwd)?.dir;
	else {
		try {
			configured = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).blok?.dir;
		} catch {}
	}
	const dir = resolve(cwd, flag ?? configured ?? ".");
	return {
		root: cwd,
		language,
		dir,
		nodes: join(dir, "nodes"),
		workflows: join(dir, "workflows"),
		generated: join(dir, "workflows", "blok"),
		built: join(dir, ".blok", "workflows"),
	};
}

/** Where a node lives: `billing/charge-card@2` is `<nodes>/billing/charge-card/v2`. */
export function nodeFolder(paths: Paths, id: string): string {
	const [path, version] = id.split("@");
	return join(paths.nodes, ...path.split("/"), `v${version}`);
}

export interface WorkflowFile {
	id: string;
	/** The file name without its ending. */
	name: string;
	file: string;
	source: "pkl" | "json";
	workflow: Workflow;
}

export interface Analysis {
	paths: Paths;
	/** The nodes, by id. */
	nodes: Map<string, Unit>;
	workflows: WorkflowFile[];
	/** What each workflow reads and answers with. */
	shapes: Map<string, WorkflowShape>;
	/** Nodes whose contract is written and whose logic is not. */
	empty: string[];
	/** Nodes that have a contract.json beside them. */
	locked: string[];
	/**
	 * What a kernel that does not check workflows itself calls each node's contract. The build writes these
	 * down, and that kernel refuses to load a build made from other contracts. Empty for TypeScript.
	 */
	fingerprints: Record<string, string>;
	problems: string[];
}

function writeIfChanged(file: string, content: string) {
	let current: string | undefined;
	try {
		current = readFileSync(file, "utf8");
	} catch {}
	if (current === content) return;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

let validator: ReturnType<Ajv2020["compile"]> | undefined;
/** What is wrong with the structure of a hand-written JSON workflow, as sentences. */
function structure(value: unknown): string[] {
	validator ??= new Ajv2020({ allErrors: true }).compile(JSON.parse(asset("workflow.schema.json")));
	if (validator(value)) return [];
	const said = new Set<string>();
	for (const error of validator.errors ?? []) {
		const at = error.instancePath === "" ? "the workflow" : error.instancePath.slice(1).replaceAll("/", ".");
		// The schema picks the kind of entry with if/then/else, and that choice reports itself as an error too. Skip the echo.
		if (error.keyword === "if") continue;
		if (error.keyword === "additionalProperties")
			said.add(`${at} has an unknown key "${error.params.additionalProperty}".`);
		else if (error.keyword === "enum") said.add(`${at} must be one of: ${error.params.allowedValues.join(", ")}.`);
		else if (error.keyword === "required") said.add(`${at} is missing "${error.params.missingProperty}".`);
		else said.add(`${at} ${error.message}.`);
	}
	return [...said];
}

const stepsIn = (entries: Entry[] = []): string[] =>
	entries.flatMap((entry) => {
		if ("conditions" in entry)
			return entry.conditions.flatMap((branch) => stepsIn("else" in branch ? branch.else : branch.steps));
		if ("parallel" in entry) return stepsIn(entry.parallel);
		if ("fail" in entry) return [];
		return [entry.node, ...stepsIn(entry.onError ?? []), ...stepsIn(entry.undo ?? [])];
	});

/**
 * Loads the nodes, regenerates the typed Pkl steps, evaluates every workflow and checks all of it.
 * It never throws for something the author can fix: those come back in `problems`.
 */
export async function analyze(paths: Paths, pkl: PklOptions = {}): Promise<Analysis> {
	const result: Analysis = {
		paths,
		nodes: new Map(),
		workflows: [],
		shapes: new Map(),
		empty: [],
		locked: [],
		fingerprints: {},
		problems: [],
	};
	try {
		if (paths.language.name === "python") {
			// The project's own kernel reads the node files and prints their contracts.
			const found = pythonNodes(paths.root, paths.dir);
			result.nodes = found.nodes;
			result.fingerprints = found.fingerprints;
			result.problems.push(...found.problems);
			if (result.problems.length > 0) return result;
		} else result.nodes = await discoverNodes(paths.nodes);
	} catch (err) {
		result.problems.push((err as Error).message);
		return result;
	}
	result.empty = [...result.nodes.values()].filter(isTodo).map((unit) => unit.id);

	let nodeFiles: StepsFile[];
	try {
		nodeFiles = nodeSteps(result.nodes.values());
	} catch (err) {
		result.problems.push((err as Error).message);
		return result;
	}
	// Each node module gets a generated file named after it, beside two files with names of their own.
	for (const id of result.nodes.keys()) {
		const module = id.split("/")[0];
		if (module === "workflows" || module === "workflow") {
			result.problems.push(`${id}: a node module cannot be called "${module}". That name belongs to the workflows.`);
		}
	}
	const sameFile = new Map<string, string>();
	for (const { file } of nodeFiles) {
		// `user-accounts` and `useraccounts` would be userAccounts.pkl and useraccounts.pkl, one file on a Mac or on Windows.
		const other = sameFile.get(file.toLowerCase());
		if (other)
			result.problems.push(`The node modules behind ${other} and ${file} differ only by a hyphen. Rename one.`);
		sameFile.set(file.toLowerCase(), file);
	}
	if (result.problems.length > 0) return result;

	// A node with a contract.json beside it has promised that contract. Anything else is a change nobody agreed to.
	for (const unit of result.nodes.values()) {
		let promised: Locked | undefined;
		try {
			promised = readLock(nodeFolder(paths, unit.id));
		} catch (err) {
			result.problems.push(`${unit.id}: its ${LOCK_FILE} is not valid JSON: ${(err as Error).message}`);
			continue;
		}
		if (!promised) continue;
		result.locked.push(unit.id);
		const changed = drift(unit, promised);
		if (changed.length === 0) continue;
		const base = unit.id.split("@")[0];
		result.problems.push(
			`${unit.id}: its ${changed.join(" and ")} ${changed.length === 1 && changed[0] !== "errors" ? "is" : "are"} not what ${LOCK_FILE} promises. To change a contract, run "blokctl new version ${base}" and change the copy. If this node is still being designed, run "blokctl lock ${unit.id}".`,
		);
	}

	const files = existsSync(paths.workflows) ? readdirSync(paths.workflows).sort() : [];
	const pklFiles = files.filter((file) => file.endsWith(".pkl"));
	const jsonFiles = files.filter((file) => file.endsWith(".json"));
	const twice = new Set<string>();
	for (const file of jsonFiles) {
		if (pklFiles.includes(`${basename(file, ".json")}.pkl`)) {
			result.problems.push(`${file} and ${basename(file, ".json")}.pkl are the same workflow written twice. Keep one.`);
			twice.add(file);
		}
	}

	// Hand-written JSON needs no evaluation, only a look at its structure.
	// The schema goes beside the files, where their "$schema" finds it and an editor reads it.
	if (jsonFiles.length > 0) {
		mkdirSync(paths.generated, { recursive: true });
		writeIfChanged(join(paths.generated, "workflow.schema.json"), asset("workflow.schema.json"));
		writeIfChanged(join(paths.generated, ".gitignore"), "*\n");
	}
	const ready: WorkflowFile[] = [];
	for (const file of jsonFiles) {
		if (twice.has(file)) continue;
		const name = basename(file, ".json");
		let workflow: Workflow;
		try {
			workflow = JSON.parse(readFileSync(join(paths.workflows, file), "utf8"));
		} catch (err) {
			result.problems.push(`${file} is not valid JSON: ${(err as Error).message}`);
			continue;
		}
		const wrong = structure(workflow);
		if (wrong.length > 0) result.problems.push(...wrong.map((problem) => `${file}: ${problem}`));
		else ready.push({ id: workflowId(name, workflow), name, file, source: "json", workflow });
	}

	if (pklFiles.length > 0) {
		mkdirSync(paths.generated, { recursive: true });
		writeIfChanged(join(paths.generated, "Workflow.pkl"), asset("Workflow.pkl"));
		for (const { file, content } of nodeFiles) writeIfChanged(join(paths.generated, file), content);
		writeIfChanged(join(paths.generated, ".gitignore"), "*\n");
		// The folder is this tool's alone. A typed-steps file for a module that is gone would keep an editor
		// completing nodes that no longer exist, so anything this run did not write is removed.
		const mine = new Set(["Workflow.pkl", "workflows.pkl", ...nodeFiles.map(({ file }) => file)]);
		for (const file of readdirSync(paths.generated, { recursive: true, encoding: "utf8" })) {
			if (file.endsWith(".pkl") && !mine.has(file.split(/[\\/]/).join("/"))) rmSync(join(paths.generated, file));
		}

		let command: string;
		try {
			command = await findPkl(pkl);
		} catch (err) {
			result.problems.push((err as Error).message);
			return result;
		}

		// A workflow used as a step has a typed class in workflows.pkl, generated from what the check
		// learns about it. So a workflow is evaluated after the ones it uses, one round per level.
		const waiting = new Map(
			pklFiles.map((file) => [file, classesUsed(readFileSync(join(paths.workflows, file), "utf8"))]),
		);
		const typed = () => {
			// Only workflows whose own steps are all known yet: drop the rest until nothing more drops.
			let usable = [...ready];
			for (;;) {
				const ids = new Set(usable.map((entry) => entry.id));
				const next = usable.filter((entry) =>
					stepsIn(entry.workflow.steps).every((id) => !id.startsWith("workflows/") || ids.has(id)),
				);
				if (next.length === usable.length) break;
				usable = next;
			}
			return workflowSteps(usable, checkWorkflows(usable, result.nodes).shapes);
		};
		while (waiting.size > 0) {
			const { classes: have, file } = typed();
			writeIfChanged(join(paths.generated, file.file), file.content);
			let round = [...waiting].filter(([, uses]) => [...uses].every((name) => have.has(name))).map(([file]) => file);
			// Nothing is ready: a class is misspelled, or two workflows use each other. Pkl explains it best.
			if (round.length === 0) round = [...waiting.keys()];
			const evaluated = evaluate(
				command,
				round.map((file) => join(paths.workflows, file)),
			);
			if ("error" in evaluated) {
				result.problems.push(evaluated.error);
				return result;
			}
			for (const file of round) {
				const name = basename(file, ".pkl");
				const workflow = evaluated.workflows.get(join(paths.workflows, file)) as Workflow;
				// Pkl leaves an empty list out of the JSON. A workflow with no steps yet still has steps.
				workflow.steps ??= [];
				ready.push({ id: workflowId(name, workflow), name, file, source: "pkl", workflow });
				waiting.delete(file);
			}
		}
		const { file } = workflowSteps(ready, checkWorkflows(ready, result.nodes).shapes);
		writeIfChanged(join(paths.generated, file.file), file.content);
	}

	result.workflows = ready.sort((a, b) => a.id.localeCompare(b.id));
	const taken = new Set<string>();
	for (const { id, file } of result.workflows) {
		if (taken.has(id) || result.nodes.has(id)) result.problems.push(`${file}: the id "${id}" is already taken.`);
		taken.add(id);
	}
	const checked = checkWorkflows(result.workflows, result.nodes);
	result.shapes = checked.shapes;
	result.problems.push(...checked.problems);
	return result;
}

export { workflowClass };
