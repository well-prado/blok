// Loading a project from disk. Nothing is registered by hand: the folder a node lives in is its id,
// and the workflows are the JSON files that `blokctl build` wrote.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Binding, type Call, type Log, type Span, type Unit, blok, consoleLog } from "./kernel.ts";
import { type Workflow, type WorkflowShape, bindingsOf, loadChecked } from "./workflow.ts";

const NODE_FILE = /(^|[\\/])node\.[cm]?[jt]s$/;

/**
 * Imports every `<module>/<node>/v<N>/node.ts` under `dir` and refuses one whose id disagrees with its path.
 * A folder that does not exist holds no nodes.
 */
export async function discoverNodes(dir: string): Promise<Map<string, Unit>> {
	const units = new Map<string, Unit>();
	let files: string[];
	try {
		files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((file) => NODE_FILE.test(file));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return units;
		throw err;
	}
	for (const file of files.sort()) {
		const parts = file.split(/[\\/]/);
		const version = parts.at(-2) ?? "";
		const where = parts.slice(0, -2);
		if (where.length < 2 || !/^v[1-9][0-9]*$/.test(version)) {
			throw new Error(`${file} is not where a node goes. A node lives at <module>/<node>/v<N>/node.ts.`);
		}
		const expected = `${where.join("/")}@${version.slice(1)}`;
		const unit: Unit | undefined = (await import(pathToFileURL(join(dir, file)).href)).default;
		if (typeof unit?.id !== "string") throw new Error(`${file} must default-export a node.`);
		if (unit.id !== expected) throw new Error(`${file} declares "${unit.id}", but its path says "${expected}".`);
		units.set(unit.id, unit);
	}
	return units;
}

/** The file name is the id: `checkout.json` at version 1.x is `workflows/checkout@1`. */
export function workflowId(name: string, workflow: Workflow): string {
	return `workflows/${name}@${(workflow.version ?? "1").split(".")[0]}`;
}

/** Reads the workflow JSON files that `blokctl build` wrote. */
export function readBuiltWorkflows(dir: string): Array<{ id: string; workflow: Workflow }> {
	let files: string[];
	try {
		files = readdirSync(dir).filter((file) => file.endsWith(".json"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		throw new Error(`There are no built workflows at ${dir}. Run "blokctl build" first, or use "blokctl dev".`);
	}
	return files.sort().map((file) => {
		const workflow = JSON.parse(readFileSync(join(dir, file), "utf8")) as Workflow;
		return { id: workflowId(file.slice(0, -".json".length), workflow), workflow };
	});
}

export interface ProjectOptions {
	/** The folder that holds `nodes/` and `.blok/`. In most apps: `import.meta.dirname`. */
	dir: string;
	/** Where the nodes are. Default: `<dir>/nodes`. */
	nodes?: string;
	/** Where the built workflow JSON is. Default: `<dir>/.blok/workflows`. */
	workflows?: string;
	/**
	 * What `${env.NAME}` reads in a workflow, and where a signed trigger finds its secret.
	 * Default: nothing. Most apps pass `process.env`.
	 */
	env?: Record<string, string | undefined>;
}

export interface Project {
	/** Every node and every workflow, by id. Any of them can be passed to `call`. */
	units: Map<string, Unit>;
	workflows: Array<{ id: string; workflow: Workflow }>;
	/** What each workflow reads and answers with, as the check worked it out. */
	shapes: Map<string, WorkflowShape>;
	/** One per trigger: a route, a schedule, a queue or a tool. An adapter takes the kind it serves. */
	bindings: Binding[];
}

/** Loads the nodes and the built workflows, and checks that every workflow lines up with its nodes. */
export async function loadProject(options: ProjectOptions): Promise<Project> {
	const units = await discoverNodes(options.nodes ?? join(options.dir, "nodes"));
	const workflows = readBuiltWorkflows(options.workflows ?? join(options.dir, ".blok", "workflows"));
	const { shapes } = loadChecked(workflows, units, options.env);
	const bindings = workflows.flatMap(({ id, workflow }) =>
		bindingsOf(id, workflow, units.get(id) as Unit, shapes.get(id), options.env),
	);
	return { units, workflows, shapes, bindings };
}

export interface AppOptions extends ProjectOptions {
	/** What the nodes reach the outside world through. */
	ports: unknown;
	/** Where failures nobody is there to answer are written. Default: the console, for errors only. */
	log?: Log;
	/** Called once for every node and workflow that ran. */
	onSpan?: (span: Span) => void;
}

/** A loaded project that can run: what every adapter starts from. */
export interface App extends Project {
	call: Call;
	log: Log;
}

/**
 * Loads the project once, for an app that starts more than one thing from it:
 *
 *     const app = await loadApp({ dir: import.meta.dirname, ports, env: process.env });
 *     await server.register(blokFastify, app);
 *     await startCron(app);
 */
export async function loadApp(options: AppOptions): Promise<App> {
	const project = await loadProject(options);
	const log = options.log ?? consoleLog;
	const { call } = blok<unknown>().runtime({ ports: options.ports, log, onSpan: options.onSpan });
	return { ...project, call, log };
}

/** An adapter takes an app that is already loaded, or the options to load one. */
export const ready = (source: App | AppOptions): Promise<App> =>
	"call" in source ? Promise.resolve(source) : loadApp(source);
