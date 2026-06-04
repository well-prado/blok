/**
 * Branded HTTP-response envelope.
 *
 * A workflow step (typically the `@blokjs/respond` node, as the final step)
 * returns a `RespondEnvelope` to control the full HTTP response — status code,
 * arbitrary headers (incl. `Location` for redirects), repeatable `Set-Cookie`
 * values, the body, and the `Content-Type`. The `http` trigger recognizes the
 * brand on the final `ctx.response.data` and unpacks it; any non-branded result
 * keeps the default behaviour (JSON / string body, status 200).
 *
 * The envelope is the carrier for *dynamic* response metadata (status/headers
 * depend on runtime inputs, so they can't ride a static node field like
 * `contentType`). It travels as ordinary step data — no `ctx` mutation, no
 * runner-core changes — so the mechanism is fully additive and HTTP-specific.
 */
export const RESPOND_BRAND = "__blokRespond__" as const;

export interface RespondEnvelope {
	readonly [RESPOND_BRAND]: true;
	/**
	 * Response body. `string` → written verbatim; `Uint8Array`/`Buffer`/
	 * `ArrayBuffer` → written as raw bytes; any other value → JSON-encoded.
	 * Omit (or `null`/`undefined`) for empty-body responses (e.g. a 302).
	 */
	body?: unknown;
	/** HTTP status code. Defaults to 200. */
	status?: number;
	/**
	 * Content-Type. Overrides the default. When omitted: `application/json`
	 * for object bodies, `application/octet-stream` for binary bodies.
	 */
	contentType?: string;
	/** Response headers, e.g. `{ Location: "/next" }` or `{ "Content-Disposition": "attachment; filename=\"x.pdf\"" }`. */
	headers?: Record<string, string>;
	/**
	 * Raw `Set-Cookie` header values. Each entry becomes its own `Set-Cookie`
	 * header (the header legitimately repeats), so a single response can set
	 * multiple cookies. Format each value yourself, e.g.
	 * `"session=abc; Path=/; HttpOnly; SameSite=Lax"`.
	 */
	cookies?: string[];
}

/**
 * Type guard: is `value` a branded {@link RespondEnvelope}? Used by the `http`
 * trigger to decide whether to unpack response metadata or fall through to the
 * default JSON/string/binary handling.
 */
export function isRespondEnvelope(value: unknown): value is RespondEnvelope {
	return (
		typeof value === "object" && value !== null && (value as Record<string | symbol, unknown>)[RESPOND_BRAND] === true
	);
}

export default RespondEnvelope;
