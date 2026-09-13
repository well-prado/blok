/**
 * Streaming `multipart/form-data` parser (#1016).
 *
 * Why not `Request.formData()`: it buffers every part in memory, so a 32 MiB
 * upload is 32 MiB of heap per in-flight request and the size limit can only
 * be enforced AFTER the whole body has been read. This parser walks the body
 * stream once, counts bytes as they arrive (so the limit trips mid-stream,
 * before any workflow runs), and spills a file part to a temp file as soon as
 * it crosses the spool threshold — the part never sits in memory whole.
 *
 * Scope (deliberate): RFC 7578 as browsers actually emit it — CRLF
 * delimiters, `content-disposition: form-data` with `name` / `filename`, an
 * optional per-part `content-type`. No nested `multipart/mixed` (deprecated
 * since RFC 7578 §4.3), no `content-transfer-encoding` decoding (same).
 */

import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { expandFormEntries } from "./nestedFields";

/** Thrown when a request body exceeds the configured upload cap. */
export class UploadTooLargeError extends Error {
	readonly maxBytes: number;
	readonly actualBytes?: number;

	constructor(maxBytes: number, actualBytes?: number) {
		super(`Request body exceeds the ${maxBytes} byte upload limit`);
		this.name = "UploadTooLargeError";
		this.maxBytes = maxBytes;
		this.actualBytes = actualBytes;
	}
}

/** Thrown when the body is not parseable as the declared multipart type. */
export class MalformedMultipartError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MalformedMultipartError";
	}
}

/**
 * A `File` whose bytes live in a temp file instead of the heap — what a part
 * larger than the spool threshold becomes. `instanceof File` holds, so node
 * code that type-checks uploads keeps working; `stream()` is the cheap read
 * path, `arrayBuffer()` / `bytes()` / `text()` load the file on demand.
 */
export class SpooledFile extends File {
	/** Absolute path of the temp file. Deleted when the request finishes. */
	readonly path: string;
	readonly #size: number;

	constructor(path: string, name: string, size: number, type: string) {
		super([], name, { type });
		this.path = path;
		this.#size = size;
	}

	override get size(): number {
		return this.#size;
	}

	override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
		return Readable.toWeb(createReadStream(this.path)) as unknown as ReadableStream<Uint8Array<ArrayBuffer>>;
	}

	override async arrayBuffer(): Promise<ArrayBuffer> {
		const buf = await readFile(this.path);
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
	}

	override async bytes(): Promise<Uint8Array<ArrayBuffer>> {
		return new Uint8Array(await this.arrayBuffer());
	}

	override async text(): Promise<string> {
		return readFile(this.path, "utf8");
	}

	// ponytail: a disk-backed slice would need a second temp file for no known
	// caller. Read through stream()/bytes() instead; revisit if a node needs
	// ranged reads.
	override slice(): Blob {
		throw new Error("SpooledFile.slice() is not supported — read it with stream(), bytes() or arrayBuffer()");
	}
}

/**
 * One parsed multipart body. Bracket keys are expanded (see
 * `./nestedFields.ts`), so both maps can nest: `user[avatar]` puts a `File`
 * at `files.user.avatar`. `cleanup()` removes every spooled temp file.
 */
export type MultipartBody = {
	fields: Record<string, unknown>;
	files: Record<string, unknown>;
	cleanup: () => Promise<void>;
};

export type MultipartOptions = {
	/** Hard cap on the whole body. Exceeding it throws `UploadTooLargeError`. */
	maxBytes: number;
	/** Per-file threshold above which the part is spooled to disk. */
	spoolBytes: number;
};

const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");
const DASHES = Buffer.from("--");

/** Extract the boundary token from a `multipart/form-data` content-type. */
export function readBoundary(contentType: string): string | undefined {
	const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
	const raw = match?.[1] ?? match?.[2];
	return raw ? raw.trim() : undefined;
}

function headerValue(headers: string, name: string): string | undefined {
	for (const line of headers.split("\r\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		if (line.slice(0, idx).trim().toLowerCase() === name) return line.slice(idx + 1).trim();
	}
	return undefined;
}

/**
 * Read one `content-disposition` parameter.
 *
 * Every form is anchored on a parameter boundary (`^` or `;`) — without it
 * `name=` matches inside `filename=`, so a part whose disposition lists
 * `filename` first would take the file name as its field name.
 */
function dispositionParam(disposition: string, param: string): string | undefined {
	const at = "(?:^|;)\\s*";
	const quoted = new RegExp(`${at}${param}="([^"]*)"`, "i").exec(disposition);
	if (quoted) return quoted[1];
	const extended = new RegExp(`${at}${param}\\*=(?:UTF-8'[^']*')?([^;]+)`, "i").exec(disposition);
	if (extended?.[1]) {
		try {
			return decodeURIComponent(extended[1].trim());
		} catch {
			return extended[1].trim();
		}
	}
	const bare = new RegExp(`${at}${param}=([^;]+)`, "i").exec(disposition);
	return bare ? bare[1].trim() : undefined;
}

type PendingPart = {
	name: string;
	filename?: string;
	type: string;
	chunks: Buffer[];
	size: number;
	path?: string;
	handle?: Awaited<ReturnType<typeof open>>;
};

/**
 * Parse a multipart request body, streaming it once.
 *
 * @throws {UploadTooLargeError} when the body crosses `maxBytes`.
 * @throws {MalformedMultipartError} when the boundary or framing is broken.
 */
export async function parseMultipartBody(req: Request, opts: MultipartOptions): Promise<MultipartBody> {
	const boundary = readBoundary(req.headers.get("content-type") ?? "");
	if (!boundary) throw new MalformedMultipartError("multipart/form-data without a boundary parameter");

	// Cheap pre-check: a declared content-length over the cap is refused
	// without reading a single byte off the socket.
	const declared = Number(req.headers.get("content-length") ?? Number.NaN);
	if (Number.isFinite(declared) && declared > opts.maxBytes) {
		throw new UploadTooLargeError(opts.maxBytes, declared);
	}

	const delimiter = Buffer.concat([CRLF, DASHES, Buffer.from(boundary)]);
	// Ordered, duplicates kept: `expandFormEntries` needs the wire order to
	// build `tags[]`/`tags[0]` arrays and to apply last-wins for plain names.
	const fieldEntries: Array<[string, unknown]> = [];
	const fileEntries: Array<[string, File]> = [];

	let tempDir: string | undefined;
	let spoolCount = 0;
	const cleanup = async (): Promise<void> => {
		if (!tempDir) return;
		const dir = tempDir;
		tempDir = undefined;
		await rm(dir, { recursive: true, force: true });
	};

	const addValue = (name: string, value: unknown): void => {
		fieldEntries.push([name, value]);
		if (value instanceof File) fileEntries.push([name, value]);
	};

	// Prepending a CRLF lets the very first `--boundary` match the same
	// delimiter as every later one — no special case for the opening line.
	let buf: Buffer = Buffer.from(CRLF);
	let state: "seek" | "after" | "headers" | "body" | "done" = "seek";
	let part: PendingPart | null = null;
	let total = 0;

	const writePart = async (chunk: Buffer): Promise<void> => {
		if (!part || chunk.length === 0) return;
		part.size += chunk.length;
		if (part.handle) {
			await part.handle.write(chunk);
			return;
		}
		part.chunks.push(chunk);
		// A file part crossing the threshold moves to disk, buffered bytes and
		// all, and every later chunk goes straight to the file.
		if (part.filename !== undefined && part.size > opts.spoolBytes) {
			tempDir ??= await mkdtemp(join(tmpdir(), "blok-upload-"));
			part.path = join(tempDir, `part-${spoolCount++}`);
			part.handle = await open(part.path, "w");
			for (const buffered of part.chunks) await part.handle.write(buffered);
			part.chunks = [];
		}
	};

	const finishPart = async (): Promise<void> => {
		if (!part) return;
		const done = part;
		part = null;
		if (done.handle && done.path) {
			await done.handle.close();
			addValue(done.name, new SpooledFile(done.path, done.filename ?? "", done.size, done.type));
			return;
		}
		const bytes = Buffer.concat(done.chunks);
		if (done.filename !== undefined) {
			addValue(done.name, new File([bytes], done.filename, { type: done.type }));
			return;
		}
		addValue(done.name, bytes.toString("utf8"));
	};

	/** Consume as much of `buf` as the current state allows. */
	const drain = async (): Promise<void> => {
		for (;;) {
			if (state === "done") return;

			if (state === "seek") {
				const at = buf.indexOf(delimiter);
				if (at === -1) return;
				buf = buf.subarray(at + delimiter.length);
				state = "after";
				continue;
			}

			if (state === "after") {
				if (buf.length < 2) return;
				if (buf.subarray(0, 2).equals(DASHES)) {
					state = "done";
					return;
				}
				const eol = buf.indexOf(CRLF);
				if (eol === -1) return;
				buf = buf.subarray(eol + CRLF.length);
				state = "headers";
				continue;
			}

			if (state === "headers") {
				const end = buf.indexOf(HEADER_END);
				if (end === -1) return;
				const block = buf.subarray(0, end).toString("utf8");
				buf = buf.subarray(end + HEADER_END.length);
				const disposition = headerValue(block, "content-disposition") ?? "";
				const name = dispositionParam(disposition, "name");
				if (name === undefined) throw new MalformedMultipartError("multipart part without a name");
				const filename = dispositionParam(disposition, "filename");
				part = {
					name,
					...(filename !== undefined ? { filename } : {}),
					type:
						headerValue(block, "content-type") ?? (filename !== undefined ? "application/octet-stream" : "text/plain"),
					chunks: [],
					size: 0,
				};
				state = "body";
				continue;
			}

			// state === "body"
			const at = buf.indexOf(delimiter);
			if (at === -1) {
				// Everything but a possible partial delimiter is safe to emit.
				const keep = delimiter.length - 1;
				if (buf.length > keep) {
					await writePart(buf.subarray(0, buf.length - keep));
					buf = buf.subarray(buf.length - keep);
				}
				return;
			}
			await writePart(buf.subarray(0, at));
			await finishPart();
			buf = buf.subarray(at + delimiter.length);
			state = "after";
		}
	};

	// Read through closures: `state` and `part` are only ever assigned inside
	// `drain()`, which TypeScript's flow analysis cannot see from out here.
	const finished = (): boolean => state === "done";
	const closePending = async (): Promise<void> => {
		if (part?.handle) await part.handle.close().catch(() => {});
	};

	try {
		const stream = req.body;
		if (stream) {
			// ponytail: on overflow / malformed framing we keep reading the rest
			// of the body and discard it instead of cancelling the stream —
			// abandoning a half-read body mid-flight breaks the sender (and makes
			// an in-process `app.request` FormData stream throw). The client gets
			// a clean 413. Upgrade to a hard cancel if wasted bandwidth on
			// deliberate over-sends ever shows up.
			let failure: Error | null = null;
			for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
				total += chunk.byteLength;
				if (failure || finished()) continue;
				if (total > opts.maxBytes) {
					failure = new UploadTooLargeError(opts.maxBytes, total);
					buf = Buffer.alloc(0);
					continue;
				}
				buf = Buffer.concat([buf, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)]);
				try {
					await drain();
				} catch (err) {
					failure = err as Error;
					buf = Buffer.alloc(0);
				}
				if (finished()) buf = Buffer.alloc(0);
			}
			if (failure) throw failure;
		} else {
			const whole = Buffer.from(await req.arrayBuffer());
			total = whole.length;
			if (total > opts.maxBytes) throw new UploadTooLargeError(opts.maxBytes, total);
			buf = Buffer.concat([buf, whole]);
			await drain();
		}
		if (!finished()) throw new MalformedMultipartError("multipart body ended before the closing boundary");
	} catch (err) {
		await closePending();
		await cleanup();
		throw err;
	}

	// `user[name]` / `tags[0]` / `docs[]` become real structure — the files map
	// through the SAME expansion so `docs[0]`,`docs[1]` is a `File[]` there too.
	return { fields: expandFormEntries(fieldEntries), files: expandFormEntries(fileEntries), cleanup };
}
