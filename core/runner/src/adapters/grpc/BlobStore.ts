/**
 * ADR 0014 Phase 2 — the claim-check primitive for the runtime boundary.
 *
 * Data crossing the gRPC boundary is inlined in one unary message and fully
 * buffered on both ends, under a symmetric 16 MiB default limit. Phase 1 made
 * an oversized call fail loudly before dispatch; this is the primitive that
 * lets it succeed instead: the runner writes the oversized blob to a directory
 * BOTH processes can read, and sends a small JSON sentinel in its place.
 *
 * ```json
 * { "$blokBlob": { "id": "<runId>/<uuid>", "bytes": 297812344, "codec": "json" } }
 * ```
 *
 * The sentinel travels inside the EXISTING `bytes` fields — no new proto field,
 * no new RPC, nothing to implement in seven languages beyond a file read.
 *
 * Enabled only when `BLOK_BLOB_DIR` points at a directory the runner and the
 * sidecar both see (same host in dev; a shared `emptyDir` in the Helm chart).
 * Unset → {@link blobStoreFromEnv} returns `null` and every call stays inline,
 * exactly as before.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import path from "node:path";

/** Capability string an SDK advertises on `ListNodes` when it can resolve sentinels. */
export const BLOB_CAPABILITY = "blob-v1";

/** Default offload threshold — matches `BLOK_STATE_SNAPSHOT_MAX_BYTES`'s 1 MB precedent. */
export const DEFAULT_BLOB_THRESHOLD_BYTES = 1024 * 1024;

/**
 * Default janitor retention for orphaned blobs. Request-direction blobs are
 * deleted as soon as the RPC settles, so anything still on disk is the debris
 * of a crashed runner; one hour is a wide margin over the 30 s default call
 * deadline. Raise it (`BLOK_BLOB_RETENTION_MS`) if a future phase parks refs in
 * `ctx.state` across a durable `wait`.
 */
export const DEFAULT_BLOB_RETENTION_MS = 60 * 60 * 1000;

/** The on-wire claim-check sentinel. */
export interface BlobRef {
	readonly $blokBlob: {
		/** `<runId>/<uuid>` — a path relative to `BLOK_BLOB_DIR`, never absolute. */
		readonly id: string;
		/** Size of the referenced payload, so the reader can sanity-check it. */
		readonly bytes: number;
		/** Encoding of the referenced bytes. Only `json` exists today. */
		readonly codec: "json";
	};
}

/**
 * A blob id is exactly two path segments of `[A-Za-z0-9._-]`, neither of which
 * may START with a dot — that one extra rule is what rejects `..`, the
 * traversal that would otherwise turn a claim-check into an arbitrary-file
 * read. Enforced on BOTH ends: the runner only mints ids of this shape, and
 * every reader re-validates a wire-supplied id before touching the filesystem.
 */
const BLOB_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** Type guard for the sentinel. Rejects a malformed or path-traversing id. */
export function isBlobRef(value: unknown): value is BlobRef {
	if (value === null || typeof value !== "object") return false;
	const inner = (value as { $blokBlob?: unknown }).$blokBlob;
	if (inner === null || typeof inner !== "object") return false;
	const { id, bytes, codec } = inner as { id?: unknown; bytes?: unknown; codec?: unknown };
	return typeof id === "string" && BLOB_ID.test(id) && typeof bytes === "number" && codec === "json";
}

/**
 * Filesystem-backed claim-check store, rooted at `BLOK_BLOB_DIR`.
 *
 * ponytail: synchronous `fs` on purpose. The offload path only runs for
 * payloads already above the threshold, and the caller has ALREADY blocked the
 * loop `JSON.stringify`-ing that same payload in `GrpcCodec` — a sync write
 * adds no new class of stall, and it keeps `executeStream`'s synchronous
 * construction path identical to `execute`'s. Swap to `fs/promises` if a
 * profile ever shows the write dominating.
 */
export class BlobStore {
	constructor(readonly dir: string) {}

	/** Write `bytes` under this run and return the sentinel to send in its place. */
	put(runId: string, bytes: Buffer): BlobRef {
		const runDir = path.join(this.dir, segment(runId));
		mkdirSync(runDir, { recursive: true });
		const name = `${randomUUID()}.json`;
		writeFileSync(path.join(runDir, name), bytes);
		return { $blokBlob: { id: `${segment(runId)}/${name}`, bytes: bytes.length, codec: "json" } };
	}

	/** Read a blob back. Throws if the ref is malformed or the file is gone. */
	get(ref: BlobRef): Buffer {
		if (!isBlobRef(ref)) throw new Error("[blok][blob] refusing to read a malformed blob ref");
		return readFileSync(path.join(this.dir, ref.$blokBlob.id));
	}

	/** Delete one blob. Best-effort — a missing file is not an error. */
	delete(ref: BlobRef): void {
		if (!isBlobRef(ref)) return;
		rmSync(path.join(this.dir, ref.$blokBlob.id), { force: true });
	}

	/** Delete every blob belonging to a run. Best-effort. */
	deleteForRun(runId: string): void {
		rmSync(path.join(this.dir, segment(runId)), { recursive: true, force: true });
	}

	/**
	 * Delete run directories untouched since `cutoffMs`. Crash-safety net for
	 * blobs whose owning RPC never got to clean up. Returns how many run
	 * directories were removed.
	 */
	purgeExpired(cutoffMs: number): number {
		if (!existsSync(this.dir)) return 0;
		let purged = 0;
		for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const runDir = path.join(this.dir, entry.name);
			try {
				if (statSync(runDir).mtimeMs >= cutoffMs) continue;
				rmSync(runDir, { recursive: true, force: true });
				purged++;
			} catch {
				// Raced with another sweep or a live write — skip it; the next
				// sweep picks it up.
			}
		}
		return purged;
	}
}

/**
 * Collapse anything unsafe in a run id down to a single path segment matching
 * {@link BLOB_ID}'s first half — separators become `-`, and a leading dot is
 * dropped so a run id of `..` can never name the parent directory.
 */
function segment(runId: string): string {
	const cleaned = runId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
	return cleaned.length > 0 ? cleaned : "run";
}

let cached: { dir: string; store: BlobStore } | null = null;

/**
 * The configured store, or `null` when `BLOK_BLOB_DIR` is unset — which is the
 * default, so the claim-check path is inert until an operator opts in on both
 * the runner and the sidecars.
 */
export function blobStoreFromEnv(env: NodeJS.ProcessEnv = process.env): BlobStore | null {
	const dir = env.BLOK_BLOB_DIR;
	if (!dir) return null;
	if (cached?.dir !== dir) cached = { dir, store: new BlobStore(dir) };
	return cached.store;
}

/** Payload size above which the runner offloads instead of inlining. */
export function blobThresholdBytes(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number.parseInt(env.BLOK_BLOB_THRESHOLD_BYTES ?? "", 10);
	return Number.isNaN(parsed) || parsed <= 0 ? DEFAULT_BLOB_THRESHOLD_BYTES : parsed;
}

/** How long an orphaned blob survives before the janitor sweeps it. */
export function blobRetentionMs(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number.parseInt(env.BLOK_BLOB_RETENTION_MS ?? "", 10);
	return Number.isNaN(parsed) || parsed <= 0 ? DEFAULT_BLOB_RETENTION_MS : parsed;
}

/** Test-only — drop the memoized store so a changed `BLOK_BLOB_DIR` is picked up. */
export function _resetBlobStoreForTests(): void {
	cached = null;
}
