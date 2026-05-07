/**
 * The typed `$` proxy — typed sugar over the runtime's `js/...` resolver.
 *
 * Property access on `$` builds a path string at definition time. The
 * `unwrapProxies` deep-walk in the `workflow()` factory replaces each proxy
 * value with its compiled `"js/ctx.<path>"` string before the workflow is
 * handed to the runner. This means:
 *
 * - Authors get IDE autocomplete on `$.req.body.foo`, `$.state.users[0]`, etc.
 * - The runtime sees plain strings (no Proxy traversal at execution time).
 * - The existing `Mapper.jsMapper` resolver works unchanged — it already
 *   evaluates `js/...` strings against `ctx`.
 *
 * @example
 *   import { workflow, $ } from "@blokjs/helper";
 *
 *   workflow({
 *     trigger: { http: { method: "GET" } },
 *     steps: [
 *       { id: "fetch", use: "@blokjs/api-call",
 *         inputs: { userId: $.req.params.id } },
 *       { id: "respond", use: "@blokjs/respond",
 *         inputs: { body: $.state.fetch } }
 *     ]
 *   });
 *   // After `unwrapProxies` runs at definition time:
 *   //   inputs.userId === "js/ctx.req.params.id"
 *   //   inputs.body   === "js/ctx.state.fetch"
 */

/** Internal symbol used to detect proxy values during the deep-walk. */
export const JS_EXPR_TAG = Symbol("blok.jsExpr");

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NUMERIC_RE = /^\d+$/;

/**
 * The shape of any sub-path of the `$` proxy. Property and index access
 * are recursive; string conversion produces a `js/ctx....` literal.
 *
 * Typed as `unknown` at the leaves so authors can pass a path anywhere a
 * value of any type is expected without `as` casts.
 */
export type ExprPath = {
	readonly [key: string]: ExprPath;
} & {
	toString(): string;
	toJSON(): string;
};

/**
 * The top-level `$` proxy. Provides typed access to:
 * - `$.req`  — request envelope (alias of `ctx.request`)
 * - `$.prev` — previous step's response envelope (alias of `ctx.response`)
 * - `$.state` — accumulated step outputs by step id
 * - `$.env` — process env mirror
 * - `$.step` — current step metadata (`{ name, index, total, depth }`)
 * - `$.workflow` — current workflow metadata
 *
 * Plus legacy fallbacks for `$.request` (= `$.req`) and `$.response` (= `$.prev`).
 */
export interface DollarProxy {
	readonly req: ExprPath;
	readonly request: ExprPath;
	readonly prev: ExprPath;
	readonly response: ExprPath;
	readonly state: ExprPath;
	readonly vars: ExprPath;
	readonly env: ExprPath;
	readonly step: ExprPath;
	readonly workflow: ExprPath;
	/** Escape hatch — any property; returns a sub-path. */
	readonly [key: string]: ExprPath;
}

function makeProxy(prefix: string): unknown {
	// Use a function as the target so `typeof` is `function` — that lets us
	// distinguish proxy values from plain objects in `unwrapProxies`. The
	// function is never called; it's just a tag.
	const target = (() => prefix) as { [JS_EXPR_TAG]?: string };
	target[JS_EXPR_TAG] = prefix;

	return new Proxy(target, {
		get(_target, key) {
			if (key === JS_EXPR_TAG) return prefix;
			if (key === Symbol.toPrimitive) return (_hint: string) => `js/${prefix}`;
			if (key === "toString") return () => `js/${prefix}`;
			if (key === "toJSON") return () => `js/${prefix}`;
			if (key === "valueOf") return () => `js/${prefix}`;
			// Don't pretend to be a thenable — Promise.resolve() probes `.then`.
			if (key === "then") return undefined;
			// Ignore inherited symbols (Symbol.iterator, etc.).
			if (typeof key === "symbol") return undefined;

			const k = String(key);
			let next: string;
			if (NUMERIC_RE.test(k)) {
				next = `${prefix}[${k}]`;
			} else if (IDENT_RE.test(k)) {
				next = `${prefix}.${k}`;
			} else {
				next = `${prefix}[${JSON.stringify(k)}]`;
			}
			return makeProxy(next);
		},
	});
}

/**
 * The `$` proxy entry point. All paths root at `ctx`.
 *
 * @see DollarProxy for the typed surface.
 */
export const $: DollarProxy = makeProxy("ctx") as DollarProxy;

/**
 * Recursively replace any `$` proxy values inside `value` with their
 * compiled `"js/ctx.<path>"` strings.
 *
 * Called by `workflow()` and `branch()` factories at definition time to
 * convert in-memory proxy references into the wire-shape strings the
 * runner's `Mapper` expects.
 *
 * Unwraps:
 * - Proxies → `"js/ctx.<path>"` strings
 * - Plain objects → walked recursively, returning a NEW object
 * - Arrays → walked, returning a NEW array
 *
 * Leaves alone:
 * - Primitives (string, number, boolean, null, undefined)
 * - Class instances (anything with a non-Object prototype)
 * - Functions other than the proxy itself
 *
 * Pure — never mutates the input.
 */
export function unwrapProxies<T>(value: T): T {
	return unwrap(value) as T;
}

function unwrap(value: unknown): unknown {
	if (value === null || value === undefined) return value;

	// Detect proxy via the tag symbol.
	if (typeof value === "function") {
		const tag = (value as { [JS_EXPR_TAG]?: string })[JS_EXPR_TAG];
		if (typeof tag === "string") {
			return `js/${tag}`;
		}
		// Other functions — leave as-is.
		return value;
	}

	if (Array.isArray(value)) {
		return value.map(unwrap);
	}

	// Plain object only — class instances pass through untouched.
	if (typeof value === "object") {
		const proto = Object.getPrototypeOf(value);
		if (proto === null || proto === Object.prototype) {
			const out: Record<string, unknown> = {};
			for (const k of Object.keys(value)) {
				out[k] = unwrap((value as Record<string, unknown>)[k]);
			}
			return out;
		}
	}

	return value;
}
