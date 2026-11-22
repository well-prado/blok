// Workflows keep the feel of the original Blok JSON, with one difference: a step carries
// its own `inputs`, so a step is defined in one place. Values are plain strings, and
// `${step.field}` reads what an earlier step produced. Nothing is evaluated as code.
import {
	BlokError,
	type Call,
	type HttpBinding,
	type Schema,
	type Unit,
	type WorkflowCtx,
	contract,
	defineUnit,
} from "./kernel.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Step {
	name: string;
	node: string;
	/** What the node is given. Strings may hold ${...} placeholders. */
	inputs?: Record<string, Json>;
	/** Run only when this holds: "${a.b}", or "${a.b} > 100" with == != > >= < <=. */
	if?: string;
	/** Run once per element of this list. Inputs read the element as ${item}. The step's result is the list of results. */
	each?: string;
	concurrency?: number;
	/** Steps to run when this one fails. They can read ${error}. The workflow still fails afterwards. */
	onError?: Entry[];
	/**
	 * Steps that take this step back. They run when a LATER step fails, the newest first, and the workflow
	 * still fails with that later step's error. They can read this step's result and ${error}.
	 */
	undo?: Entry[];
}
/**
 * Refuses the request with an error code, which is how a workflow says no without a node for it.
 * With `if`, it refuses only when the condition holds.
 */
export interface Fail {
	fail: string;
	/** What the caller is told. It may hold ${...} placeholders. */
	message?: string;
	if?: string;
}
/** The original `conditions` list: the first branch whose `if` holds runs, otherwise `else`. */
export interface Conditions {
	conditions: Branch[];
}
export type Branch = { if: string; steps: Entry[] } | { else: Entry[] };
export interface Parallel {
	parallel: Entry[];
}
export type Entry = Step | Conditions | Parallel | Fail;

export interface Workflow {
	$schema?: string;
	name: string;
	description?: string;
	version?: string;
	trigger?: {
		http?: {
			method: HttpBinding["method"];
			path: string;
			accept?: string;
			/** The status of a successful answer. Default 200. A workflow that creates something answers 201. */
			status?: number;
			/** Error code to HTTP status. */
			errors?: Record<string, number>;
		};
	};
	steps: Entry[];
	/** What the workflow answers with. Left out, it answers with the result of the last step that ran. */
	result?: Json;
}

// ---- strings ----------------------------------------------------------------------------

type Path = string[];
type Part = string | { path: Path };
type Op = "==" | "!=" | ">" | ">=" | "<" | "<=";
interface Condition {
	left: Path;
	op?: Op;
	right?: { path: Path } | { value: string | number | boolean | null };
}

const TOKEN = /\$\$\{|\$\{([^}]*)\}/g;
const PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const CONDITION = /^\s*\$\{([^}]*)\}\s*(?:(==|!=|>=|<=|>|<)\s*(.+?))?\s*$/;

function path(inside: string): Path {
	const trimmed = inside.trim();
	if (!PATH.test(trimmed)) {
		throw new SyntaxError(`"\${${inside}}" is not a path. Only a path such as \${order.items} can go inside \${ }.`);
	}
	return trimmed.split(".");
}

const parsed = new Map<string, Part[]>();
/** Splits "order ${order.id}" into text and paths. "$${" is a literal "${". */
function parts(text: string): Part[] {
	const known = parsed.get(text);
	if (known) return known;
	const out: Part[] = [];
	let last = 0;
	for (const match of text.matchAll(TOKEN)) {
		if (match.index > last) out.push(text.slice(last, match.index));
		out.push(match[0] === "$${" ? "${" : { path: path(match[1]) });
		last = match.index + match[0].length;
	}
	if (last < text.length) out.push(text.slice(last));
	parsed.set(text, out);
	return out;
}

/** The path of a string that is one placeholder and nothing else. */
function whole(text: string): Path | undefined {
	try {
		const pieces = parts(text);
		return pieces.length === 1 && typeof pieces[0] !== "string" ? pieces[0].path : undefined;
	} catch {
		return undefined;
	}
}

function condition(text: string): Condition {
	const match = CONDITION.exec(text);
	if (!match) {
		throw new SyntaxError(
			`"${text}" is not a condition. Write \${a.b}, or \${a.b} followed by == != > >= < <= and a value.`,
		);
	}
	const left = path(match[1]);
	if (!match[2]) return { left };
	const raw = match[3];
	const ref = /^\$\{([^}]*)\}$/.exec(raw);
	if (ref) return { left, op: match[2] as Op, right: { path: path(ref[1]) } };
	const quoted = /^'([^']*)'$|^"([^"]*)"$/.exec(raw);
	let value: string | number | boolean | null;
	if (quoted) value = quoted[1] ?? quoted[2];
	else if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
	else if (raw === "true" || raw === "false") value = raw === "true";
	else if (raw === "null") value = null;
	else if (/^[A-Za-z0-9_-]+$/.test(raw)) value = raw;
	else
		throw new SyntaxError(
			`"${text}": "${raw}" is not a value. Use a number, true, false, null, a word or 'quoted text'.`,
		);
	return { left, op: match[2] as Op, right: { value } };
}

// ---- run --------------------------------------------------------------------------------

type Scope = Record<string, unknown>;
const NOTHING = Symbol("nothing ran yet");

/** Turns a workflow into a unit, so the kernel can run it, trace it and bind it like any node. */
export function workflowUnit(
	id: string,
	workflow: Workflow,
	units: ReadonlyMap<string, Unit>,
	opts: {
		isWorkflow?: (id: string) => boolean;
		env?: Record<string, string | undefined>;
		/** What the workflow reads from its request, as the check derived it. Missing fields are refused before any step runs. */
		request?: JsonSchema;
	} = {},
): Unit {
	const fail = (code: string, message: string) => new BlokError(code, message, id);
	const needed = opts.request ? requiredPaths(opts.request) : [];

	const read = (target: Path, scope: Scope): unknown => {
		const [root, ...fields] = target;
		if (!(root in scope) || scope[root] === NOTHING) {
			throw fail("workflow_ref", `"\${${target.join(".")}}" is not available at this point.`);
		}
		let value = scope[root];
		for (const field of fields) {
			if (value === null || typeof value !== "object") {
				throw fail("workflow_ref", `"\${${target.join(".")}}" has nothing at "${field}".`);
			}
			value = (value as Record<string, unknown>)[field];
		}
		return value;
	};

	const render = (value: Json, scope: Scope): unknown => {
		if (typeof value === "string") {
			const pieces = parts(value);
			// A string that is one placeholder and nothing else keeps the value's own type.
			if (pieces.length === 1 && typeof pieces[0] !== "string") return read(pieces[0].path, scope);
			return pieces
				.map((piece) => {
					if (typeof piece === "string") return piece;
					const found = read(piece.path, scope);
					if (found === null || found === undefined) throw fail("workflow_ref", `"${value}" has an empty placeholder.`);
					return typeof found === "object" ? JSON.stringify(found) : String(found);
				})
				.join("");
		}
		if (Array.isArray(value)) return value.map((entry) => render(entry, scope));
		if (value !== null && typeof value === "object") {
			return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, render(entry, scope)]));
		}
		return value;
	};

	const holds = (text: string, scope: Scope): boolean => {
		const { left, op, right } = condition(text);
		const a = read(left, scope);
		if (!op || !right) {
			if (typeof a !== "boolean") throw fail("workflow_if", `"${text}" is not true or false.`);
			return a;
		}
		const b = "path" in right ? read(right.path, scope) : right.value;
		if (op === "==") return a === b;
		if (op === "!=") return a !== b;
		if (typeof a !== "number" || typeof b !== "number")
			throw fail("workflow_if", `"${text}" compares things that are not numbers.`);
		return op === ">" ? a > b : op === ">=" ? a >= b : op === "<" ? a < b : a <= b;
	};

	/** What has to be taken back if a later step fails: the undo steps of each step that finished, oldest first. */
	type Undos = Array<{ steps: Entry[]; scope: Scope }>;

	async function run(entries: Entry[], scope: Scope, call: Call, undos: Undos): Promise<void> {
		for (const entry of entries) {
			if ("conditions" in entry) {
				const chosen = entry.conditions.find((branch) => "else" in branch || holds(branch.if, scope));
				if (chosen) await run("else" in chosen ? chosen.else : chosen.steps, scope, call, undos);
			} else if ("parallel" in entry) {
				// Every branch is left to finish, also when one fails. A step still running would otherwise
				// finish after the undo steps had run, and never be taken back.
				const ends = await Promise.allSettled(entry.parallel.map((one) => run([one], scope, call, undos)));
				const failed = ends.find((end) => end.status === "rejected");
				if (failed) throw failed.reason;
				scope.prev = NOTHING; // Several steps finished at once, so "the previous one" means nothing here.
			} else if ("fail" in entry) {
				if (entry.if !== undefined && !holds(entry.if, scope)) continue;
				const told = entry.message === undefined ? `Refused: ${entry.fail}.` : String(render(entry.message, scope));
				throw fail(entry.fail, told);
			} else {
				if (entry.if && !holds(entry.if, scope)) continue;
				const unit = units.get(entry.node);
				if (!unit) throw fail("workflow_node", `Step "${entry.name}" uses "${entry.node}", which is not loaded.`);
				const once = (inside: Scope) => {
					const inputs = render(entry.inputs ?? {}, inside);
					// A workflow called as a step receives its inputs as the request body, as the original did.
					return call(unit, opts.isWorkflow?.(entry.node) ? { body: inputs } : inputs, { key: entry.name });
				};
				try {
					if (entry.each) {
						const list = render(entry.each, scope);
						if (!Array.isArray(list)) throw fail("workflow_each", `"${entry.each}" is not a list.`);
						scope[entry.name] = await mapLimit(list, entry.concurrency ?? 1, (item) => {
							const inside: Scope = Object.create(scope);
							inside.item = item;
							return once(inside);
						});
					} else {
						scope[entry.name] = await once(scope);
					}
				} catch (err) {
					if (!entry.onError) throw err;
					const inside: Scope = Object.create(scope);
					const known = err instanceof BlokError ? err : new BlokError("unexpected", String(err), id);
					inside.error = { code: known.code, message: known.message, node: known.node };
					await run(entry.onError, inside, call, undos);
					throw err;
				}
				if (entry.undo) undos.push({ steps: entry.undo, scope });
				scope.prev = scope[entry.name];
			}
		}
	}

	return defineUnit({
		kind: "workflow",
		id,
		description: workflow.description,
		input: ANYTHING,
		output: ANYTHING,
		async run(request: unknown, { call, log }: WorkflowCtx) {
			// A request that lacks something a step is certain to need would fail at that step anyway.
			// Refusing it here means no earlier step has run and nothing has to be undone.
			const absent = needed.filter((target) => dig(request, target) === undefined);
			if (absent.length > 0) {
				throw fail("invalid_input", `The request is missing: ${absent.map((target) => target.join(".")).join(", ")}.`);
			}
			const scope: Scope = Object.create(null);
			scope.request = request ?? {};
			scope.env = opts.env ?? {};
			scope.prev = NOTHING;
			const undos: Undos = [];
			try {
				await run(workflow.steps, scope, call, undos);
			} catch (err) {
				// Compensation: every step that finished and can be taken back is taken back, the newest first.
				// One undo that fails does not stop the others, and the caller still gets the error that caused it.
				const known = err instanceof BlokError ? err : new BlokError("unexpected", String(err), id);
				for (const undo of undos.reverse()) {
					const inside: Scope = Object.create(undo.scope);
					inside.error = { code: known.code, message: known.message, node: known.node };
					try {
						await run(undo.steps, inside, call, []);
					} catch (undoErr) {
						log.error(`${id}: a step could not be undone after "${known.code}".`, undoErr);
					}
				}
				throw err;
			}
			if (workflow.result !== undefined) return render(workflow.result, scope);
			return scope.prev === NOTHING ? null : scope.prev;
		},
	});
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	let failed = false;
	const worker = async () => {
		// After a failure nothing new is started, and what is already running is left to finish.
		while (next < items.length && !failed) {
			const index = next++;
			try {
				results[index] = await fn(items[index]);
			} catch (err) {
				failed = true;
				throw err;
			}
		}
	};
	const ends = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
	const broken = ends.find((end) => end.status === "rejected");
	if (broken) throw broken.reason;
	return results;
}

/** A workflow validates nothing itself beyond the request fields it needs. The nodes it calls validate at their own boundaries. */
const ANYTHING: Schema<unknown> = {
	"~standard": {
		version: 1,
		vendor: "blok",
		validate: (value) => ({ value }),
		jsonSchema: { input: () => ({}), output: () => ({}) },
	},
};

const dig = (value: unknown, target: Path): unknown =>
	target.reduce<unknown>(
		(at, field) => (at !== null && typeof at === "object" ? (at as Record<string, unknown>)[field] : undefined),
		value,
	);

/** Every path that is required all the way down from the root. */
function requiredPaths(shape: JsonSchema, prefix: Path = []): Path[] {
	return (shape.required ?? []).flatMap((field) => {
		const here = [...prefix, field];
		const deeper = requiredPaths(shape.properties?.[field] ?? {}, here);
		return deeper.length > 0 ? deeper : [here];
	});
}

export function httpBinding(workflow: Workflow, unit: Unit): HttpBinding | undefined {
	const http = workflow.trigger?.http;
	if (!http) return undefined;
	return { kind: "http", method: http.method, path: http.path, unit, success: http.status, status: http.errors };
}

// ---- check ------------------------------------------------------------------------------
// The original only found a wrong reference when the request that hit it failed. This reads
// the node contracts and finds it when the workflow is loaded.

export interface JsonSchema {
	type?: string | string[];
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	enum?: unknown[];
	additionalProperties?: boolean | JsonSchema;
	anyOf?: JsonSchema[];
}
export type Shapes = (
	node: string,
) => { input?: JsonSchema; output?: JsonSchema; errors?: readonly string[] } | undefined;
type Visible = Map<string, JsonSchema | undefined>;

const NAME = /^[A-Za-z0-9_-]+$/;
const CODE = /^[a-z][a-z0-9_]*$/;
const RESERVED = new Set(["request", "env", "prev", "item", "error"]);
const ERROR_SHAPE: JsonSchema = {
	type: "object",
	properties: { code: { type: "string" }, message: { type: "string" }, node: { type: "string" } },
	additionalProperties: false,
};
const typeOf = (shape?: JsonSchema) => (typeof shape?.type === "string" ? shape.type : undefined);
const numeric = (kind?: string) => kind === undefined || kind === "integer" || kind === "number";
const fits = (from?: JsonSchema, into?: JsonSchema) => {
	const a = typeOf(from);
	const b = typeOf(into);
	return !a || !b || a === b || (a === "integer" && b === "number");
};
/** The kinds a value may be: one for "string", two for text that may be null. Unknown when the schema does not say. */
function kindsOf(shape?: JsonSchema): string[] | undefined {
	if (!shape) return undefined;
	if (typeof shape.type === "string") return [shape.type];
	if (Array.isArray(shape.type)) return shape.type;
	if (Array.isArray(shape.anyOf)) {
		const each = shape.anyOf.map(kindsOf);
		return each.every((kinds) => kinds !== undefined) ? [...new Set(each.flat() as string[])] : undefined;
	}
	return undefined;
}
/** The part of a schema that describes one kind: the object inside "an object or null". */
const asKind = (shape: JsonSchema | undefined, kind: string): JsonSchema | undefined =>
	shape?.anyOf ? shape.anyOf.find((member) => kindsOf(member)?.includes(kind)) : shape;

/**
 * Why a value shaped like `from` cannot go where `into` is expected, all the way down: into the fields
 * of an object and the items of a list. Nothing when it fits, or where either side does not say.
 */
function misfit(from: JsonSchema | undefined, into: JsonSchema | undefined, where = ""): string | undefined {
	const have = kindsOf(from);
	const want = kindsOf(into);
	if (!have || !want) return undefined;
	const wrong = have.filter((kind) => !want.includes(kind) && !(kind === "integer" && want.includes("number")));
	if (wrong.length > 0) {
		const it = where || "it";
		return wrong.length === 1 && wrong[0] === "null" && have.length > 1
			? `${it} may be null, and ${want.join(" or ")} is needed`
			: `${it} is ${have.join(" or ")}, and ${want.join(" or ")} is needed`;
	}
	const [source, target] = [asKind(from, "object"), asKind(into, "object")];
	if (source?.properties && target?.properties) {
		for (const [key, wanted] of Object.entries(target.properties)) {
			const path = where ? `${where}.${key}` : key;
			const needed = (target.required ?? []).includes(key);
			if (!(key in source.properties)) {
				// A closed object that lacks the field can never supply it. An open one might.
				if (needed && source.additionalProperties === false) return `${where || "it"} has no "${key}"`;
				continue;
			}
			if (needed && !(source.required ?? []).includes(key)) return `${path} may be missing`;
			const deeper = misfit(source.properties[key], wanted, path);
			if (deeper) return deeper;
		}
	}
	const [list, wantedList] = [asKind(from, "array"), asKind(into, "array")];
	if (list?.items && wantedList?.items) return misfit(list.items, wantedList.items, `${where}[]`);
	return undefined;
}

const literalShape = (value: unknown): JsonSchema => ({
	type: value === null ? "null" : Number.isInteger(value) ? "integer" : typeof value,
});

/** A copy with every `required` list removed: the shape of a value nothing is certain to need. */
function optional(shape: JsonSchema): JsonSchema {
	const { required: _dropped, ...rest } = shape;
	if (rest.items) rest.items = optional(rest.items);
	if (rest.properties) {
		rest.properties = Object.fromEntries(Object.entries(rest.properties).map(([key, inner]) => [key, optional(inner)]));
	}
	return rest;
}

/** Whether a value is certain to be read when the workflow runs, and whether the node input it feeds is required. */
interface Use {
	certain: boolean;
	required: boolean;
}
const LOOSE: Use = { certain: false, required: false };

export interface Checked {
	problems: string[];
	/** What the workflow answers with. */
	returns?: JsonSchema;
	/**
	 * What the workflow reads from its request: `body`, `query`, `params` and `headers`.
	 * Nobody writes this down. It follows from the node inputs the request fields are wired into.
	 */
	request: JsonSchema;
	/** Every error code a step of this workflow may fail with. */
	errors: string[];
}

export function checkWorkflow(workflow: Workflow, shapes: Shapes): Checked {
	const problems: string[] = [];
	const request: JsonSchema = { type: "object", properties: {} };
	const route = workflow.trigger?.http?.path;
	const routeParams = new Set([...(route ?? "").matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]));

	/** Records one read of the request, so the request's shape builds up from how it is used. */
	const note = (target: Path, expected: JsonSchema | undefined, need: boolean, at: string) => {
		if (target[0] !== "request") return;
		const shown = `\${${target.join(".")}}`;
		if (target[1] === "params" && target[2] && route && !routeParams.has(target[2])) {
			problems.push(`${at}: ${shown} reads a path parameter, but the path "${route}" has no ":${target[2]}".`);
		}
		let shape = request;
		for (const field of target.slice(1)) {
			shape.type ??= "object";
			shape.properties ??= {};
			if (need && !shape.required?.includes(field)) shape.required = [...(shape.required ?? []), field];
			shape.properties[field] ??= {};
			shape = shape.properties[field];
		}
		if (!expected) return;
		const [mine, theirs] = [typeOf(shape), typeOf(expected)];
		if (mine && theirs && mine !== theirs && !(numeric(mine) && numeric(theirs))) {
			problems.push(`${at}: ${shown} is needed as ${theirs} here and as ${mine} in another step.`);
			return;
		}
		const from = need ? structuredClone(expected) : optional(expected);
		if (theirs && (!mine || theirs === "integer")) shape.type = theirs;
		if (from.enum && !shape.enum) shape.enum = from.enum;
		if (from.items && !shape.items) shape.items = from.items;
		if (from.properties) {
			shape.properties = { ...from.properties, ...shape.properties };
			if (from.required) shape.required = [...new Set([...(shape.required ?? []), ...from.required])];
		}
	};

	if (!Array.isArray(workflow.steps)) return { problems: ['A workflow needs a list of "steps".'], request, errors: [] };
	if (workflow.steps.length === 0) return { problems: ["It has no steps yet. Add at least one."], request, errors: [] };
	/** Each error code the workflow may fail with, and what may fail with it first. */
	const fails = new Map<string, string>();

	// Step names are one flat list across the whole workflow, branches included.
	const names = new Set<string>();
	const collect = (entries: Entry[]) => {
		for (const entry of entries) {
			if ("conditions" in entry)
				for (const branch of entry.conditions) collect("else" in branch ? branch.else : branch.steps);
			else if ("parallel" in entry) collect(entry.parallel);
			else if ("fail" in entry) {
				if (typeof entry.fail !== "string" || !CODE.test(entry.fail)) {
					problems.push(
						`"${entry.fail}" cannot be an error code. Use lower case and underscores, such as cart_is_empty.`,
					);
				}
			} else if (typeof entry.name === "string" && typeof entry.node === "string") {
				if (!NAME.test(entry.name) || RESERVED.has(entry.name)) problems.push(`"${entry.name}" cannot be a step name.`);
				if (names.has(entry.name)) problems.push(`Two steps are named "${entry.name}".`);
				names.add(entry.name);
				collect(entry.onError ?? []);
				collect(entry.undo ?? []);
			} else problems.push("A step needs a name and a node, or must be a conditions, parallel or fail entry.");
		}
	};
	collect(workflow.steps);

	const shapeOf = (target: Path, visible: Visible, at: string): JsonSchema | undefined => {
		const [root, ...fields] = target;
		const shown = `\${${target.join(".")}}`;
		if (!visible.has(root)) {
			if (root === "ctx")
				problems.push(`${at}: ${shown} uses "ctx", which is gone. Write \${request.body.x} or \${step-name.field}.`);
			else if (root === "prev") problems.push(`${at}: ${shown} has no single previous step here. Use the step's name.`);
			else if (names.has(root))
				problems.push(`${at}: ${shown} reads step "${root}", which may not have run at this point.`);
			else problems.push(`${at}: ${shown} reads "${root}", which does not exist.`);
			return undefined;
		}
		let shape = visible.get(root);
		let walked = root;
		for (const field of fields) {
			if (typeOf(shape) === "array" && /^\d+$/.test(field)) shape = shape?.items;
			else if (typeOf(shape) === "array") {
				// A step with `each` produces a list, so its fields are per element, not on the result.
				problems.push(`${at}: "${walked}" is a list, so it has no field "${field}".`);
				return undefined;
			} else if (!shape?.properties)
				return undefined; // Shape unknown from here on: nothing more to check.
			else if (field in shape.properties) shape = shape.properties[field];
			else if (shape.additionalProperties === false) {
				problems.push(
					`${at}: "${walked}" has no field "${field}". It has: ${Object.keys(shape.properties).join(", ")}.`,
				);
				return undefined;
			} else return undefined;
			walked += `.${field}`;
		}
		return shape;
	};

	const check = (
		value: Json,
		expected: JsonSchema | undefined,
		visible: Visible,
		at: string,
		use: Use = LOOSE,
	): JsonSchema => {
		if (typeof value === "string") {
			if (value.startsWith("js/")) {
				problems.push(
					`${at}: "js/" expressions are gone. Reference a value with \${...}, or move the logic into a node.`,
				);
				return {};
			}
			let pieces: Part[];
			try {
				pieces = parts(value);
			} catch (err) {
				problems.push(`${at}: ${(err as Error).message}`);
				return {};
			}
			const refs = pieces.filter((piece): piece is { path: Path } => typeof piece !== "string");
			if (refs.length === 1 && pieces.length === 1) {
				const shape = shapeOf(refs[0].path, visible, at);
				note(refs[0].path, expected, use.certain && use.required, at);
				if (!fits(shape, expected)) {
					problems.push(`${at}: expects ${typeOf(expected)}, but ${value} is ${typeOf(shape)}.`);
				} else {
					// The same kind on the outside. Now the inside: the fields of an object, the items of a list.
					const why = misfit(shape, expected);
					if (why) problems.push(`${at}: ${value} does not fit. In it, ${why}.`);
				}
				return shape ?? {};
			}
			for (const ref of refs) {
				shapeOf(ref.path, visible, at);
				// Text with an empty placeholder cannot be built, so a placeholder inside text is always needed.
				note(ref.path, undefined, use.certain, at);
			}
		}
		// Inside a list or an object, the value is still read, but nothing says the node needs it.
		const inner: Use = { certain: use.certain, required: false };
		if (Array.isArray(value)) {
			value.forEach((entry, i) => check(entry, expected?.items, visible, `${at}[${i}]`, inner));
			return { type: "array" };
		}
		if (value !== null && typeof value === "object") {
			const properties = Object.fromEntries(
				Object.entries(value).map(([key, entry]) => [
					key,
					check(entry, expected?.properties?.[key], visible, `${at}.${key}`, inner),
				]),
			);
			// Every key that is written is there, so every one is required.
			return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
		}
		const literal = literalShape(value);
		if (!fits(literal, expected))
			problems.push(`${at}: expects ${typeOf(expected)}, but got ${JSON.stringify(value)}.`);
		if (expected?.enum && !expected.enum.includes(value)) {
			problems.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(expected.enum)}.`);
		}
		return literal;
	};

	const checkIf = (text: string, visible: Visible, at: string) => {
		let parsedCondition: Condition;
		try {
			parsedCondition = condition(text);
		} catch (err) {
			problems.push(`${at}: ${(err as Error).message}`);
			return;
		}
		const { left, op, right } = parsedCondition;
		const a = typeOf(shapeOf(left, visible, at));
		if (!op || !right) {
			note(left, { type: "boolean" }, false, at);
			if (a && a !== "boolean") problems.push(`${at}: "${text}" is ${a}, not true or false. Compare it with a value.`);
			return;
		}
		note(left, "path" in right ? undefined : literalShape(right.value), false, at);
		if ("path" in right) note(right.path, undefined, false, at);
		const b = typeOf("path" in right ? shapeOf(right.path, visible, at) : literalShape(right.value));
		const ordered = op !== "==" && op !== "!=";
		if (ordered ? !numeric(a) || !numeric(b) : a && b && a !== b && !(numeric(a) && numeric(b))) {
			problems.push(`${at}: "${text}" compares ${a ?? "something"} with ${b ?? "something"}.`);
		}
	};

	/** `counts` is false inside undo steps: a failure there is logged, and never becomes the workflow's error. */
	const walk = (entries: Entry[], visible: Visible, certain: boolean, counts = true): Visible => {
		for (const entry of entries) {
			if ("conditions" in entry) {
				const hadPrev = visible.has("prev");
				const ends = entry.conditions.map((branch) => {
					if (!("else" in branch)) checkIf(branch.if, visible, "conditions");
					return walk("else" in branch ? branch.else : branch.steps, new Map(visible), false, counts);
				});
				// Whichever branch ran, its last step is the previous step afterwards.
				const exhaustive = entry.conditions.some((branch) => "else" in branch);
				const covered = exhaustive && ends.every((end) => end.has("prev"));
				const same =
					covered && ends.every((end) => JSON.stringify(end.get("prev")) === JSON.stringify(ends[0].get("prev")));
				if (covered || hadPrev) visible.set("prev", same ? ends[0].get("prev") : undefined);
			} else if ("parallel" in entry) {
				const before = new Map(visible);
				for (const one of entry.parallel) {
					for (const [name, shape] of walk([one], new Map(before), certain, counts)) {
						if (!before.has(name) && name !== "prev") visible.set(name, shape);
					}
				}
				visible.delete("prev");
			} else if ("fail" in entry) {
				const at = `fail "${entry.fail}"`;
				if (entry.if !== undefined) checkIf(entry.if, visible, at);
				if (entry.message !== undefined) check(entry.message, { type: "string" }, visible, `${at}, message`);
				if (counts && !fails.has(entry.fail)) fails.set(entry.fail, `a "fail" entry`);
			} else if (typeof entry.name === "string" && typeof entry.node === "string") {
				const at = `step "${entry.name}"`;
				if (entry.if) checkIf(entry.if, visible, at);
				const shape = shapes(entry.node);
				if (counts) for (const code of shape?.errors ?? []) if (!fails.has(code)) fails.set(code, at);
				if (!shape) problems.push(`${at}: uses "${entry.node}", which is not a known node.`);

				let inside = visible;
				if (entry.each) {
					const list = check(entry.each, undefined, visible, `${at}, each`, {
						certain: certain && !entry.if,
						required: true,
					});
					const listed = whole(entry.each);
					if (listed) note(listed, { type: "array" }, false, at);
					if (typeOf(list) && typeOf(list) !== "array")
						problems.push(`${at}: ${entry.each} is ${typeOf(list)}, and "each" needs a list.`);
					inside = new Map(visible).set("item", list.items);
				}
				const given = entry.inputs ?? {};
				const accepted = shape?.input?.properties;
				for (const [key, value] of Object.entries(given)) {
					// An input the node does not declare is a mistake, unless the node says it takes extra keys.
					const extras = shape?.input?.additionalProperties;
					if (accepted && !(key in accepted) && (extras === undefined || extras === false)) {
						problems.push(
							`${at}: "${entry.node}" has no input "${key}". It takes: ${Object.keys(accepted).join(", ")}.`,
						);
					}
					check(value, accepted?.[key], inside, `${at}, input "${key}"`, {
						// A step that may be skipped, or that runs once per element of a list that may be empty, is certain of nothing.
						certain: certain && !entry.if && !entry.each,
						required: (shape?.input?.required ?? []).includes(key),
					});
				}
				for (const key of shape?.input?.required ?? []) {
					if (!(key in given)) problems.push(`${at}: "${entry.node}" needs input "${key}".`);
				}
				if (entry.onError) walk(entry.onError, new Map(visible).set("error", ERROR_SHAPE), false, counts);

				const result = entry.each ? { type: "array", items: shape?.output } : shape?.output;
				// Undo steps run only after this step has finished, so they can always read its result.
				if (entry.undo) {
					walk(entry.undo, new Map(visible).set(entry.name, result).set("error", ERROR_SHAPE), false, false);
				}
				if (entry.if) {
					// It may be skipped, so its name is not readable later and the previous step is uncertain.
					if (visible.has("prev")) visible.set("prev", undefined);
				} else {
					visible.set(entry.name, result).set("prev", result);
				}
			}
		}
		return visible;
	};

	const visible = walk(
		workflow.steps,
		new Map<string, JsonSchema | undefined>([
			["request", undefined],
			["env", undefined],
		]),
		true,
	);
	let returns: JsonSchema | undefined;
	if (workflow.result !== undefined) returns = check(workflow.result, undefined, visible, "result");
	else if (visible.has("prev")) returns = visible.get("prev");
	else problems.push('Nothing is left to answer with. Add a "result", or end on a single step.');

	// A failure the trigger gives no status would reach the caller as a 500, with nothing saying why.
	const http = workflow.trigger?.http;
	if (http) {
		for (const [code, who] of fails) {
			if (http.errors?.[code] === undefined) {
				problems.push(
					`${who} can fail with "${code}", and the trigger gives that no status, so a caller would get a 500. Give "${code}" a status in the trigger's errors.`,
				);
			}
		}
		if (http.status !== undefined && (!Number.isInteger(http.status) || http.status < 200 || http.status > 299)) {
			problems.push(`The trigger's status is ${http.status}. A successful answer has a status from 200 to 299.`);
		}
	}
	return { problems, returns, request, errors: [...fails.keys()] };
}

/** What a workflow takes and answers with, as a step in another workflow sees it. */
export interface WorkflowShape {
	/** The request body it reads. A workflow called as a step receives its inputs as the body. */
	input: JsonSchema;
	output?: JsonSchema;
	/** Everything it reads from the request: body, query, params and headers. */
	request: JsonSchema;
	/** Every error code it may fail with. A workflow that uses it as a step can fail with the same ones. */
	errors: string[];
}

/**
 * Checks every workflow against the node contracts, and against each other where one calls another.
 * `units` holds the nodes. Nothing is registered and nothing runs.
 */
export function checkWorkflows(
	workflows: Array<{ id: string; workflow: Workflow }>,
	units: ReadonlyMap<string, Unit>,
): { problems: string[]; shapes: Map<string, WorkflowShape> } {
	const own = new Map(workflows.map((entry) => [entry.id, entry.workflow]));
	const done = new Map<string, WorkflowShape>();
	const nodes = new Map<string, { input: JsonSchema; output: JsonSchema; errors: readonly string[] }>();
	const shapes: Shapes = (node) => {
		if (own.has(node)) return done.get(node) ?? {};
		const unit = units.get(node);
		if (!unit) return undefined;
		let known = nodes.get(node);
		if (!known) {
			const described = contract(unit);
			known = {
				input: described.input as JsonSchema,
				output: described.output as JsonSchema,
				errors: described.errors,
			};
			nodes.set(node, known);
		}
		return known;
	};

	// A workflow that calls another is checked after it, so the caller sees what the callee takes and answers with.
	const uses = (entries: Entry[]): string[] =>
		entries.flatMap((entry) => {
			if ("conditions" in entry)
				return entry.conditions.flatMap((branch) => uses("else" in branch ? branch.else : branch.steps));
			if ("parallel" in entry) return uses(entry.parallel);
			if ("fail" in entry) return [];
			return [entry.node, ...uses(entry.onError ?? []), ...uses(entry.undo ?? [])];
		});
	const problems: string[] = [];
	const waiting = new Set(workflows);
	while (waiting.size > 0) {
		const ready = [...waiting].filter((entry) =>
			uses(entry.workflow.steps ?? []).every((node) => !own.has(node) || done.has(node)),
		);
		if (ready.length === 0) {
			problems.push(
				`These workflows call each other in a circle: ${[...waiting].map((entry) => entry.id).join(", ")}.`,
			);
			break;
		}
		for (const entry of ready) {
			const result = checkWorkflow(entry.workflow, shapes);
			problems.push(...result.problems.map((problem) => `${entry.id}: ${problem}`));
			done.set(entry.id, {
				input: result.request.properties?.body ?? { type: "object", properties: {} },
				output: result.returns,
				request: result.request,
				errors: result.errors,
			});
			waiting.delete(entry);
		}
	}
	return { problems, shapes: done };
}

/**
 * Checks every workflow, then registers each one as a unit beside the nodes.
 * Throws with the full list of problems, so nothing half-wired ever runs.
 */
export function loadWorkflows(
	workflows: Array<{ id: string; workflow: Workflow }>,
	units: Map<string, Unit>,
	env: Record<string, string | undefined> = {},
): Unit[] {
	for (const { id } of workflows) if (units.has(id)) throw new Error(`Two units claim the id "${id}".`);
	const { problems, shapes } = checkWorkflows(workflows, units);
	if (problems.length > 0) throw new Error(`Workflow check failed:\n- ${problems.join("\n- ")}`);

	const own = new Set(workflows.map((entry) => entry.id));
	return workflows.map(({ id, workflow }) => {
		const unit = workflowUnit(id, workflow, units, {
			isWorkflow: (node) => own.has(node),
			env,
			request: shapes.get(id)?.request,
		});
		units.set(id, unit);
		return unit;
	});
}
