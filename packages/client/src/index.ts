/**
 * `@blokjs/client` — a fully-typed, tRPC-style client for calling Blok
 * workflows from a frontend.
 *
 * The client is **inference-based**: it imports the server's generated
 * `BlokApp` type (`blokctl gen app-types`) and maps every workflow to a typed
 * call. There is no generated runtime code — a single `Proxy` turns the access
 * path (`blok.users.list`) into the workflow name (`"users.list"`) and POSTs it
 * to the name-keyed RPC mount (`/__blok/rpc/:name`).
 *
 * @example
 *   import { createBlokClient } from "@blokjs/client";
 *   import type { BlokApp } from "./blok-app";       // generated, types only
 *
 *   const blok = createBlokClient<BlokApp>({ baseUrl: "/", headers: () => ({ Authorization: `Bearer ${token()}` }) });
 *   const { users, total } = await blok.users.list({ q: "ada" });   // typed both ways
 *
 * P1 ships the **unary** call surface (typed CRUD). Streaming (`.stream`) +
 * TanStack-Query hooks land in later phases (see SPEC-blok-client-sdk.md).
 */

import type { TypedWorkflow } from "@blokjs/helper";

/** Configuration for {@link createBlokClient}. */
export interface BlokClientConfig {
	/**
	 * Base URL the RPC mount is served from. Defaults to "" (same-origin
	 * relative — `"/__blok/rpc/:name"`). Set to e.g. `"https://api.example.com"`
	 * for a cross-origin backend. A trailing slash is trimmed.
	 */
	baseUrl?: string;
	/**
	 * Per-request header factory — called before each call so you can return a
	 * fresh auth token. May be sync or async.
	 */
	headers?: () => Record<string, string> | Promise<Record<string, string>>;
	/**
	 * `fetch` implementation. Defaults to the global `fetch`. Inject for
	 * SSR / tests / a custom runtime, or to add interceptors.
	 */
	fetch?: typeof fetch;
}

/** A typed unary call: `(input) => Promise<output>`. */
export type UnaryCall<I, O> = (input: I) => Promise<O>;

/**
 * Maps a generated `BlokApp` tree to the client's call surface: each
 * {@link TypedWorkflow} leaf becomes a typed {@link UnaryCall}; nested groups
 * recurse. (Streaming workflows are also unary in P1; their `.stream` surface
 * is added in P3 — see the spec.)
 */
export type BlokClient<T> = {
	[K in keyof T]: T[K] extends TypedWorkflow<infer I, infer O, infer _E>
		? UnaryCall<I, O>
		: T[K] extends object
			? BlokClient<T[K]>
			: never;
};

/** Thrown when an RPC call returns a non-2xx status. Carries the parsed body. */
export class BlokClientError extends Error {
	readonly status: number;
	readonly body: unknown;
	readonly workflow: string;
	constructor(status: number, body: unknown, workflow: string) {
		super(`Blok RPC "${workflow}" failed with status ${status}`);
		this.name = "BlokClientError";
		this.status = status;
		this.body = body;
		this.workflow = workflow;
	}
}

// Property keys that must NOT be treated as workflow-path segments — otherwise
// `await blok.users` (thenable probe) or a structured-clone symbol probe would
// be misread as a `.then`/symbol workflow name and break promise semantics.
const PASSTHROUGH_KEYS = new Set<string>(["then", "catch", "finally"]);

function NOOP(): void {
	/* Proxy target must be callable so the `apply` trap fires. */
}

/**
 * Create a typed Blok client. Pass the generated `BlokApp` type as the type
 * argument; the returned object's shape is inferred entirely from it.
 */
export function createBlokClient<TApp>(config: BlokClientConfig = {}): BlokClient<TApp> {
	const baseUrl = (config.baseUrl ?? "").replace(/\/+$/, "");
	const doFetch = config.fetch ?? globalThis.fetch;
	if (typeof doFetch !== "function") {
		throw new Error(
			"createBlokClient: no `fetch` available. Pass `fetch` in the config (e.g. on Node < 18 or a custom runtime).",
		);
	}

	async function unaryCall(name: string, input: unknown): Promise<unknown> {
		const extra = config.headers ? await config.headers() : {};
		const res = await doFetch(`${baseUrl}/__blok/rpc/${name}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...extra },
			body: JSON.stringify(input ?? {}),
		});
		const contentType = res.headers.get("content-type") ?? "";
		const payload: unknown = contentType.includes("application/json") ? await res.json() : await res.text();
		if (!res.ok) throw new BlokClientError(res.status, payload, name);
		return payload;
	}

	const build = (path: readonly string[]): unknown =>
		new Proxy(NOOP, {
			get(_target, key) {
				if (typeof key !== "string" || PASSTHROUGH_KEYS.has(key)) return undefined;
				return build([...path, key]);
			},
			apply(_target, _thisArg, args: unknown[]) {
				return unaryCall(path.join("."), args[0]);
			},
		});

	return build([]) as BlokClient<TApp>;
}
