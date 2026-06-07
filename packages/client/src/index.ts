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
 * Unary (typed CRUD) and **streaming** (`.stream(input)` → a typed event union
 * over SSE) are both supported. TanStack-Query hooks land in a later phase
 * (see SPEC-blok-client-sdk.md).
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
 * A typed streaming call: `.stream(input)` yields the workflow's declared event
 * union (`{ type: "progress"; data: {…} } | …`). Driven by the name-keyed RPC
 * mount with `Accept: text/event-stream`.
 */
export interface StreamCall<I, E> {
	stream(input: I): AsyncIterable<E>;
}

/**
 * Maps a generated `BlokApp` tree to the client's call surface: each
 * {@link TypedWorkflow} leaf becomes a typed {@link UnaryCall} (no declared
 * events) or a {@link StreamCall} (declared `events`); nested groups recurse.
 */
export type BlokClient<T> = {
	[K in keyof T]: T[K] extends TypedWorkflow<infer I, infer O, infer E>
		? [E] extends [never]
			? UnaryCall<I, O>
			: StreamCall<I, E>
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

// Reserved leaf method names. `blok.<path>.stream(input)` opens a streaming
// call rather than descending into a workflow group literally named "stream".
const STREAM_METHOD = "stream";

function NOOP(): void {
	/* Proxy target must be callable so the `apply` trap fires. */
}

function safeJsonParse(raw: string): unknown {
	if (raw === "") return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		// A non-JSON `data:` payload is a valid SSE frame — surface it verbatim
		// rather than dropping it (the client's "loud, never swallow" contract).
		return raw;
	}
}

/**
 * Spec-correct SSE frame parser over a `fetch` response body. Handles `event:`,
 * multi-line `data:`, `id:`, `:` comments (keep-alives), CRLF/CR/LF line
 * endings, and a trailing event with no final blank line. Yields one
 * `{ event, data, id }` per dispatched frame.
 */
async function* parseSSE(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string; id?: string }> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let event = "";
	let data: string[] = [];
	let id: string | undefined;

	type Frame = { event: string; data: string; id?: string };
	// Apply one line of the SSE stream. Returns a dispatched frame on a blank
	// line (end-of-event), else null while accumulating fields.
	const handleLine = (raw: string): Frame | null => {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (line === "") {
			if (data.length === 0 && event === "") return null;
			const frame: Frame = { event: event || "message", data: data.join("\n"), id };
			event = "";
			data = [];
			id = undefined;
			return frame;
		}
		if (line.startsWith(":")) return null; // comment / keep-alive
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let val = colon === -1 ? "" : line.slice(colon + 1);
		if (val.startsWith(" ")) val = val.slice(1);
		if (field === "event") event = val;
		else if (field === "data") data.push(val);
		else if (field === "id") id = val;
		// `retry:` is ignored — the client doesn't auto-reconnect (P3).
		return null;
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? ""; // last (possibly partial) line stays buffered
			for (const raw of lines) {
				const frame = handleLine(raw);
				if (frame) yield frame;
			}
		}
		// Drain a final complete-but-unterminated line, then flush a trailing
		// frame that wasn't closed by a blank line.
		if (buffer !== "") {
			const frame = handleLine(buffer);
			if (frame) yield frame;
		}
		if (data.length > 0 || event !== "") yield { event: event || "message", data: data.join("\n"), id };
	} finally {
		reader.releaseLock();
	}
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

	async function* streamCall(name: string, input: unknown): AsyncGenerator<{ type: string; data: unknown }> {
		const extra = config.headers ? await config.headers() : {};
		const res = await doFetch(`${baseUrl}/__blok/rpc/${name}`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "text/event-stream", ...extra },
			body: JSON.stringify(input ?? {}),
		});
		if (!res.ok) {
			const ct = res.headers.get("content-type") ?? "";
			const body: unknown = ct.includes("application/json") ? await res.json() : await res.text();
			throw new BlokClientError(res.status, body, name);
		}
		if (!res.body) {
			throw new Error(`Blok stream "${name}": the response has no readable body (no ReadableStream).`);
		}
		for await (const frame of parseSSE(res.body)) {
			yield { type: frame.event, data: safeJsonParse(frame.data) };
		}
	}

	const build = (path: readonly string[]): unknown =>
		new Proxy(NOOP, {
			get(_target, key) {
				if (typeof key !== "string" || PASSTHROUGH_KEYS.has(key)) return undefined;
				// `.stream(input)` is a streaming call on the workflow at `path`,
				// not a descent into a group named "stream".
				if (key === STREAM_METHOD) return (input: unknown) => streamCall(path.join("."), input);
				return build([...path, key]);
			},
			apply(_target, _thisArg, args: unknown[]) {
				return unaryCall(path.join("."), args[0]);
			},
		});

	return build([]) as BlokClient<TApp>;
}
