/**
 * ADR 0014 `blob-v1` claim-check — the reader half.
 *
 * The runner offloads an oversized `inputs` payload to `BLOK_BLOB_DIR` and
 * sends `{"$blokBlob":{id,bytes,codec}}` in its place. It only ever does that
 * for a runtime that advertised `blob-v1` on `ListNodes`, so the advertisement
 * and the resolver must agree: {@link resolveBlobDir} returns non-null exactly
 * when this process can service the reference.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { WorkerError } from "./errors.js";

export const BLOB_CAPABILITY = "blob-v1";

/**
 * Same id grammar the runner mints and re-validates (`BlobStore.BLOB_ID`):
 * exactly two segments, neither starting with a dot — which is what makes
 * `..` unrepresentable and keeps a wire-supplied id from escaping the dir.
 */
const BLOB_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

interface BlobRef {
	$blokBlob: { id: string; bytes: number; codec: "json" };
}

function isBlobRef(value: unknown): value is BlobRef {
	if (value === null || typeof value !== "object") return false;
	const inner = (value as { $blokBlob?: unknown }).$blokBlob;
	if (inner === null || typeof inner !== "object") return false;
	const { id, bytes, codec } = inner as { id?: unknown; bytes?: unknown; codec?: unknown };
	return typeof id === "string" && BLOB_ID.test(id) && typeof bytes === "number" && codec === "json";
}

/**
 * The blob directory this worker can actually read, or `null`. Advertise
 * `blob-v1` iff this is non-null — claiming it without a readable directory
 * makes the runner send references the node can never resolve.
 */
export function resolveBlobDir(env: Record<string, string | undefined> = process.env): string | null {
	const dir = env.BLOK_BLOB_DIR;
	if (!dir) return null;
	try {
		return statSync(dir).isDirectory() ? dir : null;
	} catch {
		return null;
	}
}

/**
 * Replace a claim-check sentinel with the payload it references. Any other
 * value passes through untouched — the sentinel only ever stands in for the
 * WHOLE `inputs` value, never for a field inside it.
 */
export function resolveClaimCheck(value: unknown, dir: string | null, maxBytes: number): unknown {
	if (dir === null || !isBlobRef(value)) return value;
	const { id, bytes } = value.$blokBlob;
	if (bytes > maxBytes) {
		throw new WorkerError(
			"BLOB_TOO_LARGE",
			`Claim-check blob ${id} is ${bytes} bytes, over this worker's ${maxBytes}-byte limit`,
			"DATA",
			413,
			false,
			"Raise BLOK_GRPC_MAX_MESSAGE_BYTES on BOTH the runner and this worker, or reduce what crosses the step boundary.",
		);
	}
	const file = path.join(dir, id);
	if (!existsSync(file)) {
		throw new WorkerError(
			"BLOB_NOT_FOUND",
			`Claim-check blob ${id} is not present under BLOK_BLOB_DIR`,
			"DEPENDENCY",
			502,
			true,
			"Point BLOK_BLOB_DIR at the same directory the runner writes to (a shared volume when they are in different containers).",
		);
	}
	const raw = readFileSync(file);
	if (raw.byteLength > maxBytes) {
		throw new WorkerError(
			"BLOB_TOO_LARGE",
			`Claim-check blob ${id} read back as ${raw.byteLength} bytes, over this worker's ${maxBytes}-byte limit`,
			"DATA",
			413,
		);
	}
	try {
		return JSON.parse(raw.toString("utf8"));
	} catch (err) {
		throw new WorkerError(
			"BLOB_DECODE_FAILED",
			`Claim-check blob ${id} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
			"DATA",
			422,
		);
	}
}
