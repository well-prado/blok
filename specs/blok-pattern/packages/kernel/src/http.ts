// What every HTTP adapter does the same way: check the signature, call the workflow, and turn what
// happened into a status and a JSON body. The adapters for Fastify, Hono and Express only translate
// their own request and response to and from this.
import { BlokError, type Call, type HttpBinding, type Log, type Signature, consoleLog } from "./kernel.ts";

export interface HttpRequest {
	method: string;
	/** The parsed JSON body, or `{}` when there is none. */
	body: unknown;
	query: unknown;
	params: unknown;
	/** Header names in lower case. */
	headers: Record<string, string | string[] | undefined>;
}
export interface HttpAnswer {
	status: number;
	body: unknown;
}
export interface AnswerOptions {
	/** The body exactly as it arrived. A signed trigger needs it: a signature is made over these bytes. */
	raw?: string | Uint8Array;
	/** Where a failure nobody planned for is written. Default: the console. */
	log?: Log;
	/** The time in milliseconds, for the age of a signed request. */
	now?: () => number;
}

const STATUS: Record<string, number> = { invalid_input: 400, not_implemented: 501 };

/** Runs the workflow behind one route and says what to answer with. It does not throw. */
export async function answer(
	binding: HttpBinding,
	call: Call,
	request: HttpRequest,
	options: AnswerOptions = {},
): Promise<HttpAnswer> {
	const log = options.log ?? consoleLog;
	if (binding.signature) {
		if (options.raw === undefined) {
			log.error(
				`${binding.unit.id} checks a signature, and the body as it arrived was gone before Blok saw the request. Mount Blok before anything that parses the body.`,
			);
			return { status: 500, body: { error: "unexpected", message: "The server could not complete the request." } };
		}
		const now = options.now?.() ?? Date.now();
		if (!(await signed(binding.signature, options.raw, request.headers, now))) {
			return { status: 401, body: { error: "invalid_signature", message: "The signature does not match." } };
		}
	}
	try {
		return { status: binding.success ?? 200, body: await call(binding.unit, request) };
	} catch (err) {
		const error = err instanceof BlokError ? err : new BlokError("unexpected", String(err), binding.unit.id);
		const status = binding.status?.[error.code] ?? STATUS[error.code];
		if (status !== undefined) {
			return { status, body: { error: error.code, message: error.message, node: error.node } };
		}
		// A failure nobody planned for. What went wrong is for the log, not for whoever sent the request.
		log.error(`${binding.unit.id} failed with "${error.code}" at ${error.node}: ${error.message}`, error.details);
		return { status: 500, body: { error: error.code, message: "The server could not complete the request." } };
	}
}

// ---- signatures --------------------------------------------------------------------------

const encoder = new TextEncoder();
/** How far a signed request's clock may be from ours. Older than this, it may be a recording played back. */
const TOLERANCE_SECONDS = 5 * 60;

type Bytes = Uint8Array<ArrayBuffer>;

function fromHex(text: string): Bytes | undefined {
	if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) return undefined;
	return Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}
function fromBase64(text: string): Bytes | undefined {
	try {
		return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
	} catch {
		return undefined;
	}
}

/** Compares in the same time whatever the bytes are, so the answer's timing says nothing about the signature. */
function same(a: Uint8Array, b: Uint8Array | undefined): boolean {
	if (!b || a.length !== b.length) return false;
	let differ = 0;
	for (let i = 0; i < a.length; i++) differ |= a[i] ^ b[i];
	return differ === 0;
}

async function hmac(secret: Bytes, before: string, body: Uint8Array): Promise<Uint8Array> {
	const prefix = encoder.encode(before);
	const message = new Uint8Array(prefix.length + body.length);
	message.set(prefix);
	message.set(body, prefix.length);
	const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
}

const recent = (seconds: string | undefined, now: number): boolean =>
	seconds !== undefined && /^\d+$/.test(seconds) && Math.abs(now / 1000 - Number(seconds)) <= TOLERANCE_SECONDS;

/** Whether the request carries a signature that the secret and this body produce. */
export async function signed(
	signature: Signature,
	raw: string | Uint8Array,
	headers: HttpRequest["headers"],
	now: number = Date.now(),
): Promise<boolean> {
	const body = typeof raw === "string" ? encoder.encode(raw) : raw;
	const header = (name: string): string | undefined => {
		const value = headers[name.toLowerCase()];
		return Array.isArray(value) ? value[0] : value;
	};

	if (signature.scheme === "standard") {
		// standardwebhooks.com: the id, the time and the body are signed together, and the secret is base64.
		const [id, time, given] = [header("webhook-id"), header("webhook-timestamp"), header("webhook-signature")];
		const secret = fromBase64(signature.secret.replace(/^whsec_/, ""));
		if (!id || !given || !secret || !recent(time, now)) return false;
		const expected = await hmac(secret, `${id}.${time}.`, body);
		// The header may carry several signatures, while the sender changes its secret.
		return given.split(" ").some((one) => one.startsWith("v1,") && same(expected, fromBase64(one.slice(3))));
	}
	if (signature.scheme === "stripe") {
		const parts = (header("stripe-signature") ?? "").split(",").map((part) => part.trim().split("="));
		const time = parts.find(([key]) => key === "t")?.[1];
		if (!recent(time, now)) return false;
		const expected = await hmac(encoder.encode(signature.secret), `${time}.`, body);
		return parts.some(([key, value]) => key === "v1" && same(expected, fromHex(value ?? "")));
	}
	const [name, prefix, encoding] =
		signature.scheme === "github"
			? ["x-hub-signature-256", "sha256=", "hex"]
			: [signature.header ?? "", signature.prefix ?? "", signature.encoding ?? "hex"];
	const given = header(name);
	if (!given?.startsWith(prefix)) return false;
	const expected = await hmac(encoder.encode(signature.secret), "", body);
	const text = given.slice(prefix.length);
	return same(expected, encoding === "hex" ? fromHex(text) : fromBase64(text));
}
