// The whole runtime of the pattern. No dependencies.
// Schemas are Standard Schema (standardschema.dev): Zod, Valibot and ArkType all qualify.

export interface Schema<I = unknown, O = I> {
	readonly "~standard": {
		readonly version: 1;
		readonly vendor: string;
		readonly validate: (value: unknown) => Validated<O> | Promise<Validated<O>>;
		readonly types?: { readonly input: I; readonly output: O } | undefined;
		/** Standard JSON Schema (standardschema.dev/json-schema). Contracts are read through it. Zod 4.2 and newer has it. */
		readonly jsonSchema?: {
			readonly input: (options: { readonly target: string }) => Record<string, unknown>;
			readonly output: (options: { readonly target: string }) => Record<string, unknown>;
		};
	};
}
type Validated<O> =
	| { readonly value: O; readonly issues?: undefined }
	| { readonly issues: ReadonlyArray<{ readonly message: string }> };
export type In<S extends Schema> = NonNullable<S["~standard"]["types"]>["input"];
export type Out<S extends Schema> = NonNullable<S["~standard"]["types"]>["output"];

/** What a unit promises. This object is the whole public surface of a node. */
export interface Contract<I extends Schema, O extends Schema> {
	/** "<module>/<node>@<version>", and it must match the folder the file lives in. */
	id: string;
	description?: string;
	input: I;
	output: O;
	/**
	 * Business failures callers may branch on, each with when it happens:
	 * `{ card_declined: "The provider refused the card." }`. A plain list of codes also works.
	 * `fail()` refuses any other code.
	 */
	errors?: readonly string[] | Readonly<Record<string, string>>;
	/** Ports this unit touches, e.g. "payments:charge". Empty means pure. */
	effects?: readonly string[];
	/** Safe to run twice with the same input. Retries only apply when true. */
	idempotent?: boolean;
	retries?: number;
	timeoutMs?: number;
}

export class BlokError extends Error {
	override name = "BlokError";
	readonly code: string;
	readonly node: string;
	readonly details?: unknown;
	constructor(code: string, message: string, node: string, details?: unknown) {
		super(message);
		this.code = code;
		this.node = node;
		this.details = details;
	}
}

export interface Log {
	info(message: string, data?: unknown): void;
	error(message: string, data?: unknown): void;
}
interface BaseCtx {
	log: Log;
	signal: AbortSignal;
	fail(code: string, message: string, details?: unknown): BlokError;
}
/** A node does work. It reaches the outside world through ports and cannot call other units. */
export interface NodeCtx<P> extends BaseCtx {
	ports: P;
}
/** A workflow only wires. It can call units and has no ports of its own. The workflow runner is its only author. */
export interface WorkflowCtx extends BaseCtx {
	call: Call;
}
export type Call = <I extends Schema, O extends Schema>(
	unit: Unit<I, O>,
	input: In<I>,
	opts?: { key?: string },
) => Promise<Out<O>>;

export interface Unit<I extends Schema = Schema, O extends Schema = Schema> extends Contract<I, O> {
	kind: "node" | "workflow";
	/** The ctx shape depends on `kind`. node() types it for authors, and the runtime builds the matching one. */
	run(input: Out<I>, ctx: never): Promise<In<O>> | In<O>;
}

export interface Span {
	id: string;
	kind: "node" | "workflow";
	parent?: string;
	key?: string;
	ms: number;
	attempts: number;
	ok: boolean;
	error?: string;
}

const ID = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)+@[1-9][0-9]*$/;

/** Checks the id and freezes the unit. node() calls it, and so does the workflow runner. */
export function defineUnit<I extends Schema, O extends Schema>(unit: Unit<I, O>): Unit<I, O> {
	if (!ID.test(unit.id)) throw new TypeError(`Bad unit id "${unit.id}". Expected "<module>/<node>@<version>".`);
	return Object.freeze(unit);
}

// A symbol from the global registry, so the mark is seen even when two copies of this package are loaded.
const TODO = Symbol.for("blok.todo");
/**
 * The body of a node whose contract is written and whose logic is not: `run: todo`.
 * Workflows can already be wired and checked against it. Calling it fails with "not_implemented".
 */
export const todo: () => never = Object.assign(
	(): never => {
		throw new Error("This node is not implemented yet.");
	},
	{ [TODO]: true },
);
export const isTodo = (unit: Unit): boolean => (unit.run as { [TODO]?: boolean })[TODO] === true;

async function parse<S extends Schema>(schema: S, value: unknown, node: string, code: string): Promise<Out<S>> {
	const result = await schema["~standard"].validate(value);
	if (result.issues) throw new BlokError(code, result.issues.map((i) => i.message).join("; "), node, result.issues);
	return result.value as Out<S>;
}

/** One app-level factory, typed by the ports the app provides. */
export function blok<P>() {
	type NodeDef<I extends Schema, O extends Schema> = Contract<I, O> & {
		run(input: Out<I>, ctx: NodeCtx<P>): Promise<In<O>> | In<O>;
	};

	const node = <I extends Schema, O extends Schema>(def: NodeDef<I, O>): Unit<I, O> =>
		defineUnit({ ...def, kind: "node" });

	function runtime(opts: { ports: P; log?: Log; onSpan?: (span: Span) => void }) {
		const log = opts.log ?? { info() {}, error() {} };

		async function exec<I extends Schema, O extends Schema>(
			unit: Unit<I, O>,
			raw: unknown,
			parent: string | undefined,
			outer: AbortSignal | undefined,
			key: string | undefined,
		): Promise<Out<O>> {
			const start = performance.now();
			let attempts = 0;
			const done = (ok: boolean, error?: string) =>
				opts.onSpan?.({
					id: unit.id,
					kind: unit.kind,
					parent,
					key,
					ms: performance.now() - start,
					attempts,
					ok,
					error,
				});
			try {
				const input = await parse(unit.input, raw, unit.id, "invalid_input");
				// After the input check, so a node that is only designed already refuses what its contract refuses.
				if (isTodo(unit)) throw new BlokError("not_implemented", `${unit.id} is not implemented yet.`, unit.id);
				const declared = new Set(errorCodes(unit));
				const fail = (code: string, message: string, details?: unknown) => {
					if (!declared.has(code))
						throw new TypeError(`${unit.id} failed with "${code}", which its contract does not declare.`);
					return new BlokError(code, message, unit.id, details);
				};
				const max = unit.idempotent ? (unit.retries ?? 0) : 0;
				for (;;) {
					attempts++;
					const signal = unit.timeoutMs
						? AbortSignal.any([AbortSignal.timeout(unit.timeoutMs), ...(outer ? [outer] : [])])
						: (outer ?? new AbortController().signal);
					const base = { log, signal, fail };
					const ctx =
						unit.kind === "workflow"
							? { ...base, call: ((u, i, o) => exec(u, i, unit.id, signal, o?.key)) as Call }
							: { ...base, ports: opts.ports };
					try {
						const aborted = new Promise<never>((_, reject) =>
							signal.addEventListener(
								"abort",
								() => reject(new BlokError("timeout", `${unit.id} was aborted`, unit.id)),
								{ once: true },
							),
						);
						const out = await Promise.race([unit.run(input, ctx as never), aborted]);
						const output = await parse(unit.output, out, unit.id, "invalid_output");
						done(true);
						return output;
					} catch (err) {
						const business = err instanceof BlokError && err.code !== "timeout";
						if (business || attempts > max) throw err;
					}
				}
			} catch (err) {
				const error =
					err instanceof BlokError
						? err
						: new BlokError("unexpected", err instanceof Error ? err.message : String(err), unit.id, err);
				done(false, error.code);
				throw error;
			}
		}

		const call: Call = (unit, input, o) => exec(unit, input, undefined, undefined, o?.key);
		return { call };
	}

	return { node, runtime };
}

/** A binding attaches a unit to a host event. It is data; an adapter reads it. */
export interface HttpBinding {
	kind: "http";
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	path: string;
	/** Called with the request: { method, body, query, params, headers }. */
	unit: Unit;
	/** The status of a successful answer. Default 200. */
	success?: number;
	/** Error code to HTTP status. Transport details stay out of the node. */
	status?: Record<string, number>;
}

/** The error codes a unit declares, whichever way it wrote them. */
export const errorCodes = (unit: Pick<Unit, "errors">): string[] =>
	Array.isArray(unit.errors) ? [...unit.errors] : Object.keys(unit.errors ?? {});

const TARGET = { target: "draft-2020-12" } as const;

/** A schema as JSON Schema. "input" is what a caller may pass (a field with a default is optional), "output" is what comes back. */
export function jsonSchemaOf(schema: Schema, io: "input" | "output", owner: string): Record<string, unknown> {
	const convert = schema["~standard"].jsonSchema;
	if (!convert) {
		throw new TypeError(
			`${owner}: its ${io} schema cannot be read as JSON Schema. Use a schema library that implements Standard JSON Schema, such as Zod 4.2 or newer.`,
		);
	}
	try {
		return convert[io](TARGET);
	} catch (err) {
		// Some types have no JSON Schema form. The library knows which one, and the node id says where to look.
		throw new TypeError(`${owner}: its ${io} schema cannot be written as JSON Schema. ${(err as Error).message}.`);
	}
}

/** The language-neutral form of a unit: what a planner writes first and what other languages and agents read. */
export function contract(unit: Unit) {
	return {
		id: unit.id,
		kind: unit.kind,
		description: unit.description,
		input: jsonSchemaOf(unit.input, "input", unit.id),
		output: jsonSchemaOf(unit.output, "output", unit.id),
		errors: errorCodes(unit),
		/** When each error happens, for the ones the node described. */
		errorMeanings: Array.isArray(unit.errors) ? {} : { ...(unit.errors as Record<string, string> | undefined) },
		effects: unit.effects ?? [],
		idempotent: unit.idempotent ?? false,
		implemented: !isTodo(unit),
	};
}
