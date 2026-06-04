import { type RespondEnvelope, isRespondEnvelope } from "@blokjs/shared";
import type { Context as HonoContext } from "hono";

/**
 * Turn a finished workflow's `ctx.response` into a Hono `Response`.
 *
 * Resolution order:
 *  1. **Branded {@link RespondEnvelope}** (from the `@blokjs/respond` node) —
 *     full control: status, arbitrary headers, repeatable `Set-Cookie`,
 *     Content-Type, and a string / binary / object / empty body.
 *  2. **Raw binary** (`Uint8Array`/`Buffer`/`ArrayBuffer`) — sent as-is with
 *     the resolved Content-Type (NOT JSON-stringified).
 *  3. **String** — written verbatim (status 200).
 *  4. **Object** — JSON (status 200).
 *
 * Cases 2–4 preserve the pre-existing trigger behaviour exactly, so workflows
 * that don't opt into a respond envelope or binary body are unaffected.
 *
 * Extracted from the trigger handler so the emission logic is unit-testable
 * against a real Hono context (`app.request(...)`).
 */
export function emitWorkflowResponse(c: HonoContext, ctxResponse: unknown): Response {
	// Module nodes wrap output in a BlokResponse ({ data, contentType, … });
	// runtime adapter nodes leave raw data on ctx.response.
	const hasWrapper =
		!!ctxResponse && typeof ctxResponse === "object" && "data" in ctxResponse && "contentType" in ctxResponse;
	const data = hasWrapper ? (ctxResponse as { data: unknown }).data : ctxResponse;

	if (isRespondEnvelope(data)) {
		return emitRespondEnvelope(c, data);
	}

	const contentType = hasWrapper
		? ((ctxResponse as { contentType?: string }).contentType ?? "application/json")
		: "application/json";
	c.header("Content-Type", contentType);
	// Raw binary is sent as-is — routing it through c.json would JSON-stringify
	// the bytes (`{"type":"Buffer","data":[…]}`) and reset the Content-Type.
	if (isBinaryBody(data)) {
		return c.body(toArrayBuffer(data), 200);
	}
	if (typeof data === "string") {
		return c.body(data, 200);
	}
	return c.json(data as object, 200);
}

/**
 * Emit a workflow-controlled response from a {@link RespondEnvelope}. Honors a
 * custom status, arbitrary headers (incl. `Location`), repeatable `Set-Cookie`
 * values, a Content-Type override, and a string / binary / object / empty body.
 */
export function emitRespondEnvelope(c: HonoContext, env: RespondEnvelope): Response {
	const status = (env.status ?? 200) as 200;
	const body = env.body;
	const binary = isBinaryBody(body);
	const contentType = env.contentType ?? (binary ? "application/octet-stream" : "application/json");

	if (env.headers) {
		for (const [key, value] of Object.entries(env.headers)) c.header(key, value);
	}
	// `Set-Cookie` legitimately repeats — append each value as its own header.
	if (env.cookies) {
		for (const cookie of env.cookies) c.header("Set-Cookie", cookie, { append: true });
	}

	// Empty body (e.g. a 302 redirect) — don't impose a Content-Type.
	if (body === undefined || body === null) {
		return c.body(null, status);
	}
	c.header("Content-Type", contentType);
	if (binary) {
		return c.body(toArrayBuffer(body as Uint8Array | ArrayBuffer), status);
	}
	if (typeof body === "string") {
		return c.body(body, status);
	}
	// Object body → JSON-encode manually (rather than c.json) so an explicit
	// `contentType` override is honored instead of being forced to JSON.
	return c.body(JSON.stringify(body), status);
}

/**
 * True when `v` is a raw binary body the trigger should send as-is.
 * `Buffer` is a `Uint8Array` subclass, so the `Uint8Array` check covers it.
 */
export function isBinaryBody(v: unknown): v is Uint8Array | ArrayBuffer {
	return v instanceof Uint8Array || v instanceof ArrayBuffer;
}

/**
 * Normalize a binary body to an `ArrayBuffer` (Hono / Web `Response` body).
 * For a `Uint8Array`/`Buffer` view, copy the exact byte window so a pooled
 * Buffer's backing store isn't leaked into the response.
 */
export function toArrayBuffer(v: Uint8Array | ArrayBuffer): ArrayBuffer {
	if (v instanceof ArrayBuffer) return v;
	return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
}
