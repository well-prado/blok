import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BlobStore,
	DEFAULT_BLOB_RETENTION_MS,
	DEFAULT_BLOB_THRESHOLD_BYTES,
	_resetBlobStoreForTests,
	blobRetentionMs,
	blobStoreFromEnv,
	blobThresholdBytes,
	isBlobRef,
} from "../../../../src/adapters/grpc/BlobStore";

describe("BlobStore (ADR 0014 Phase 2)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "blok-blob-"));
		_resetBlobStoreForTests();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		_resetBlobStoreForTests();
	});

	describe("put/get round trip", () => {
		it("writes the payload and hands back a ref that reads it straight back", () => {
			const store = new BlobStore(dir);
			const payload = Buffer.from(JSON.stringify({ symbols: Array.from({ length: 1000 }, (_, i) => `sym${i}`) }));

			const ref = store.put("run_abc", payload);

			expect(isBlobRef(ref)).toBe(true);
			expect(ref.$blokBlob.bytes).toBe(payload.length);
			expect(ref.$blokBlob.codec).toBe("json");
			expect(ref.$blokBlob.id.startsWith("run_abc/")).toBe(true);
			expect(store.get(ref).equals(payload)).toBe(true);
		});

		// `ctx.id` reaches `put()` verbatim, so a hostile or merely odd run id
		// must never be able to place a file outside the blob root.
		it.each(["../../etc/pas swd", "..", ".", "", "run/../..", "a\u0000b", "a b"])(
			"sanitizes run id %j into one in-root path segment",
			(runId) => {
				const store = new BlobStore(dir);
				const ref = store.put(runId, Buffer.from("[]"));

				expect(isBlobRef(ref)).toBe(true);
				expect(ref.$blokBlob.id.split("/")).toHaveLength(2);
				const written = path.resolve(dir, ref.$blokBlob.id);
				expect(written.startsWith(`${path.resolve(dir)}${path.sep}`)).toBe(true);
				expect(existsSync(written)).toBe(true);
			},
		);
	});

	describe("isBlobRef", () => {
		it("accepts a well-formed ref", () => {
			expect(isBlobRef({ $blokBlob: { id: "run_1/abc-123.json", bytes: 10, codec: "json" } })).toBe(true);
		});

		// The security-relevant half: a ref arrives over the wire, so every id
		// shape that could escape BLOK_BLOB_DIR must be refused.
		it.each([
			["parent traversal", { $blokBlob: { id: "../secrets/id_rsa", bytes: 1, codec: "json" } }],
			["nested traversal", { $blokBlob: { id: "run_1/../../etc/passwd", bytes: 1, codec: "json" } }],
			["absolute path", { $blokBlob: { id: "/etc/passwd", bytes: 1, codec: "json" } }],
			["single segment", { $blokBlob: { id: "passwd", bytes: 1, codec: "json" } }],
			["dotfile segment", { $blokBlob: { id: ".ssh/id_rsa", bytes: 1, codec: "json" } }],
			["missing bytes", { $blokBlob: { id: "run_1/a.json", codec: "json" } }],
			["unknown codec", { $blokBlob: { id: "run_1/a.json", bytes: 1, codec: "protobuf" } }],
			["not a ref", { hello: "world" }],
			["null", null],
			["string", "$blokBlob"],
		])("rejects %s", (_label, value) => {
			expect(isBlobRef(value)).toBe(false);
		});

		it("get() refuses a malformed ref instead of touching the filesystem", () => {
			const store = new BlobStore(dir);
			const evil = { $blokBlob: { id: "../../../etc/passwd", bytes: 1, codec: "json" } };
			expect(() => store.get(evil as never)).toThrow(/malformed blob ref/);
		});
	});

	describe("lifecycle", () => {
		it("delete() removes one blob, deleteForRun() removes the whole run", () => {
			const store = new BlobStore(dir);
			const one = store.put("run_1", Buffer.from("1"));
			const two = store.put("run_1", Buffer.from("2"));

			store.delete(one);
			expect(existsSync(path.join(dir, one.$blokBlob.id))).toBe(false);
			expect(existsSync(path.join(dir, two.$blokBlob.id))).toBe(true);

			store.deleteForRun("run_1");
			expect(existsSync(path.join(dir, "run_1"))).toBe(false);
		});

		it("purgeExpired() drops run dirs older than the cutoff and keeps fresh ones", () => {
			const store = new BlobStore(dir);
			store.put("fresh", Buffer.from("{}"));

			const staleDir = path.join(dir, "stale");
			mkdirSync(staleDir, { recursive: true });
			writeFileSync(path.join(staleDir, "a.json"), "{}");
			const longAgo = new Date(Date.now() - 10 * 60 * 60 * 1000);
			utimesSync(staleDir, longAgo, longAgo);

			const purged = store.purgeExpired(Date.now() - 60 * 60 * 1000);

			expect(purged).toBe(1);
			expect(existsSync(staleDir)).toBe(false);
			expect(existsSync(path.join(dir, "fresh"))).toBe(true);
		});

		it("purgeExpired() is a no-op on a directory that was never created", () => {
			expect(new BlobStore(path.join(dir, "never-written")).purgeExpired(Date.now())).toBe(0);
		});
	});

	describe("environment configuration", () => {
		it("blobStoreFromEnv() is null without BLOK_BLOB_DIR — the feature is opt-in", () => {
			expect(blobStoreFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
			expect(blobStoreFromEnv({ BLOK_BLOB_DIR: "" } as NodeJS.ProcessEnv)).toBeNull();
		});

		it("blobStoreFromEnv() memoizes per directory", () => {
			const first = blobStoreFromEnv({ BLOK_BLOB_DIR: dir } as NodeJS.ProcessEnv);
			expect(blobStoreFromEnv({ BLOK_BLOB_DIR: dir } as NodeJS.ProcessEnv)).toBe(first);
			expect(blobStoreFromEnv({ BLOK_BLOB_DIR: `${dir}-other` } as NodeJS.ProcessEnv)).not.toBe(first);
		});

		it("threshold + retention fall back to their defaults on unset/garbage values", () => {
			expect(blobThresholdBytes({} as NodeJS.ProcessEnv)).toBe(DEFAULT_BLOB_THRESHOLD_BYTES);
			expect(blobThresholdBytes({ BLOK_BLOB_THRESHOLD_BYTES: "nope" } as NodeJS.ProcessEnv)).toBe(
				DEFAULT_BLOB_THRESHOLD_BYTES,
			);
			expect(blobThresholdBytes({ BLOK_BLOB_THRESHOLD_BYTES: "0" } as NodeJS.ProcessEnv)).toBe(
				DEFAULT_BLOB_THRESHOLD_BYTES,
			);
			expect(blobThresholdBytes({ BLOK_BLOB_THRESHOLD_BYTES: "2048" } as NodeJS.ProcessEnv)).toBe(2048);

			expect(blobRetentionMs({} as NodeJS.ProcessEnv)).toBe(DEFAULT_BLOB_RETENTION_MS);
			expect(blobRetentionMs({ BLOK_BLOB_RETENTION_MS: "5000" } as NodeJS.ProcessEnv)).toBe(5000);
		});
	});
});
