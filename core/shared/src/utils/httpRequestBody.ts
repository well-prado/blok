/**
 * Shared HTTP request-body builder (#1016).
 *
 * One place where every trigger that speaks HTTP (http, webhook) turns a Web
 * `Request` into the `{ body, rawBody, files, method }` envelope that becomes
 * `ctx.request`. It owns three things the triggers used to do (or not do)
 * separately:
 *
 * - content-type dispatch (json / urlencoded / multipart / text),
 * - upload limits + disk spooling for multipart (see `./multipart.ts`),
 * - `_method` spoofing, the browser workaround Inertia documents for
 *   PUT/PATCH/DELETE forms (https://inertiajs.com/docs/v3/the-basics/file-uploads).
 */

import { type MultipartBody, UploadTooLargeError, parseMultipartBody } from "./multipart";

export const DEFAULT_MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
export const DEFAULT_UPLOAD_SPOOL_BYTES = 1024 * 1024;

/** Methods a `_method` field may spoof. Anything else is ignored. */
export const SPOOFABLE_METHODS: readonly string[] = ["PUT", "PATCH", "DELETE"];

export type ParsedHttpRequest = {
	/** Parsed body — object for json/form/multipart, string for text. */
	body: unknown;
	/** Raw body text, captured BEFORE parsing (empty for multipart). */
	rawBody: string;
	/** File parts by field name. Empty unless the body was multipart. */
	files: Record<string, File | File[]>;
	/** Effective method — the spoofed one when `_method` applied. */
	method: string;
	/** The method actually on the wire (`POST` for a spoofed request). */
	originalMethod: string;
	/** Removes any spooled temp file. Safe to call more than once. */
	cleanup: () => Promise<void>;
};

export type ParseHttpRequestOptions = {
	/**
	 * Parse `multipart/form-data` bodies. Off for the webhook trigger, whose
	 * signature verifiers need the raw bytes and which no provider sends
	 * multipart — parsing there would consume the body and empty `rawBody`.
	 */
	multipart?: boolean;
	/**
	 * Try `JSON.parse` on bodies whose content-type is neither json, form nor
	 * multipart, falling back to the raw text. The webhook trigger's historic
	 * behaviour (providers that post JSON with a sloppy content-type).
	 */
	jsonFallback?: boolean;
	maxBytes?: number;
	spoolBytes?: number;
};

function envBytes(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Resolve the upload limits from env, re-read per request so tests can flip them. */
export function uploadLimits(): { maxBytes: number; spoolBytes: number } {
	return {
		maxBytes: envBytes("BLOK_MAX_UPLOAD_BYTES", DEFAULT_MAX_UPLOAD_BYTES),
		spoolBytes: envBytes("BLOK_UPLOAD_SPOOL_BYTES", DEFAULT_UPLOAD_SPOOL_BYTES),
	};
}

/**
 * Apply `_method` spoofing to a parsed body, in place.
 *
 * Only a POST can spoof, only into PUT/PATCH/DELETE (case-insensitive), and
 * only when `BLOK_METHOD_SPOOFING` is not `0`. When it applies, `_method` is
 * removed from the body so the workflow never sees the transport artefact.
 *
 * @returns the effective method (the wire method when nothing applied).
 */
export function applyMethodSpoofing(wireMethod: string, body: unknown): string {
	const method = wireMethod.toUpperCase();
	if (process.env.BLOK_METHOD_SPOOFING === "0") return method;
	if (method !== "POST") return method;
	if (!body || typeof body !== "object" || Array.isArray(body)) return method;
	const record = body as Record<string, unknown>;
	const declared = record._method;
	if (typeof declared !== "string") return method;
	const spoofed = declared.trim().toUpperCase();
	if (!SPOOFABLE_METHODS.includes(spoofed)) return method;
	// biome-ignore lint/performance/noDelete: the field must be ABSENT, not undefined — workflows read the body verbatim.
	delete record._method;
	return spoofed;
}

const NO_CLEANUP = async (): Promise<void> => {};

/**
 * Parse a Web `Request` into the trigger request envelope.
 *
 * @throws {UploadTooLargeError} when the body exceeds the upload cap — the
 *   caller turns it into a 413 before any workflow runs.
 */
export async function parseHttpRequest(req: Request, opts: ParseHttpRequestOptions = {}): Promise<ParsedHttpRequest> {
	const originalMethod = req.method.toUpperCase();
	const empty: ParsedHttpRequest = {
		body: {},
		rawBody: "",
		files: {},
		method: originalMethod,
		originalMethod,
		cleanup: NO_CLEANUP,
	};
	if (originalMethod === "GET" || originalMethod === "HEAD") return empty;

	const contentType = req.headers.get("content-type") ?? "";
	const limits = uploadLimits();
	const maxBytes = opts.maxBytes ?? limits.maxBytes;
	const spoolBytes = opts.spoolBytes ?? limits.spoolBytes;

	if (opts.multipart !== false && contentType.includes("multipart/form-data")) {
		let parsed: MultipartBody;
		try {
			parsed = await parseMultipartBody(req, { maxBytes, spoolBytes });
		} catch (err) {
			if (err instanceof UploadTooLargeError) throw err;
			// Malformed multipart — same shape the trigger produced before:
			// an empty body rather than a 500.
			return empty;
		}
		const method = applyMethodSpoofing(originalMethod, parsed.fields);
		return {
			body: parsed.fields,
			rawBody: "",
			files: parsed.files,
			method,
			originalMethod,
			cleanup: parsed.cleanup,
		};
	}

	const declared = Number(req.headers.get("content-length") ?? Number.NaN);
	if (Number.isFinite(declared) && declared > maxBytes) throw new UploadTooLargeError(maxBytes, declared);

	let rawBody = "";
	try {
		rawBody = await req.text();
	} catch {
		return empty;
	}
	if (Buffer.byteLength(rawBody) > maxBytes) throw new UploadTooLargeError(maxBytes, Buffer.byteLength(rawBody));

	let body: unknown = {};
	if (contentType.includes("application/json")) {
		try {
			body = rawBody.length === 0 ? {} : JSON.parse(rawBody);
		} catch {
			// Malformed JSON — keep rawBody (a webhook verifier may still want
			// it for its 4xx) and let downstream handle the empty body.
			body = {};
		}
	} else if (contentType.includes("application/x-www-form-urlencoded")) {
		const parsed: Record<string, string> = {};
		for (const [key, value] of new URLSearchParams(rawBody)) parsed[key] = value;
		body = parsed;
	} else if (opts.jsonFallback) {
		try {
			body = rawBody.length === 0 ? {} : JSON.parse(rawBody);
		} catch {
			body = rawBody;
		}
	} else {
		body = rawBody;
	}

	return {
		body,
		rawBody,
		files: {},
		method: applyMethodSpoofing(originalMethod, body),
		originalMethod,
		cleanup: NO_CLEANUP,
	};
}
