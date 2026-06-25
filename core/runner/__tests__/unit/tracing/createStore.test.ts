import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryRunStore } from "../../../src/tracing/InMemoryRunStore";
import { createStore } from "../../../src/tracing/createStore";

// OBS-04 (PR-01): the trace store defaults to sqlite OUTSIDE tests so a bare
// `docker run` / `helm install` is durable; tests stay on memory; an in-memory
// store warns loudly outside tests.
describe("createStore — default backend (OBS-04)", () => {
	const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
	const ORIGINAL_STORE = process.env.BLOK_TRACE_STORE;
	let warn: ReturnType<typeof vi.spyOn>;
	let tmpDir: string;

	// `delete` is the only way to truly unset an env var — `= undefined` stores
	// the string "undefined". (biome's noDelete is a perf rule; irrelevant here.)
	function setStore(v: string | undefined): void {
		if (v === undefined) {
			// biome-ignore lint/performance/noDelete: must unset, not set to the string "undefined"
			delete process.env.BLOK_TRACE_STORE;
		} else {
			process.env.BLOK_TRACE_STORE = v;
		}
	}

	beforeEach(() => {
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "blok-store-"));
		setStore(undefined);
	});

	afterEach(() => {
		warn.mockRestore();
		process.env.NODE_ENV = ORIGINAL_NODE_ENV;
		setStore(ORIGINAL_STORE);
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("uses in-memory in test context, with no warning", () => {
		process.env.NODE_ENV = "test";
		const store = createStore();
		expect(store).toBeInstanceOf(InMemoryRunStore);
		expect(warn).not.toHaveBeenCalled();
	});

	it("defaults to sqlite (not memory) outside tests", () => {
		process.env.NODE_ENV = "production";
		const store = createStore({ sqlitePath: path.join(tmpDir, "trace.db") });

		// The default selected sqlite, NOT the in-memory store — so the explicit
		// "IN-MEMORY" opt-out warning must NOT fire.
		const memWarn = warn.mock.calls.find((c) => String(c[0]).includes("IN-MEMORY"));
		expect(memWarn).toBeUndefined();

		// In a real (compiled) runtime the sqlite store is created + the db file
		// exists. Under vitest the dynamic `require("./SqliteRunStore")` of the
		// sibling .ts can't resolve, so the default path gracefully falls back to
		// memory with a "sqlite unavailable" warning — exactly the safety net for
		// Node consumers missing the better-sqlite3 peer dep. Either outcome proves
		// the DEFAULT was sqlite (attempted), never the memory default branch.
		const sqliteCreated = !(store instanceof InMemoryRunStore) && fs.existsSync(path.join(tmpDir, "trace.db"));
		const sqliteAttemptedThenFellBack = warn.mock.calls.some((c) => String(c[0]).includes("sqlite unavailable"));
		expect(sqliteCreated || sqliteAttemptedThenFellBack).toBe(true);
	});

	it("warns when memory is selected explicitly outside tests", () => {
		process.env.NODE_ENV = "production";
		const store = createStore({ type: "memory" });
		expect(store).toBeInstanceOf(InMemoryRunStore);
		const memWarn = warn.mock.calls.find((c) => String(c[0]).includes("IN-MEMORY"));
		expect(memWarn).toBeDefined();
	});
});
