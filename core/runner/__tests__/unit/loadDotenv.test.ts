/**
 * #692 — `.env` loading order and precedence, in one place and tested.
 *
 * Blok used to rely entirely on Bun's implicit dotenv loading, so the same
 * entrypoint under Node loaded nothing. Harnesses compensated by keeping
 * credentials in shell memory, which is what turned a one-line fix into a
 * 20-minute clean-room rebuild.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDotenvFiles, parseDotenv, resetDotenvLoader } from "../../src/utils/loadDotenv";

let dir: string;
const touched: string[] = [];
const originalNodeEnv = process.env.NODE_ENV;

function set(key: string, value: string | undefined) {
	touched.push(key);
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "blok-dotenv-"));
	// Vitest sets NODE_ENV=test, which legitimately suppresses `.env.local`.
	// Default these cases to a dev-shaped environment; the NODE_ENV=test case
	// opts back in explicitly.
	process.env.NODE_ENV = "development";
	resetDotenvLoader();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	for (const key of touched.splice(0)) delete process.env[key];
	// biome-ignore lint/performance/noDelete: restore literal absence, not the string "undefined"
	if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = originalNodeEnv;
	resetDotenvLoader();
});

describe("parseDotenv", () => {
	it("reads KEY=value, export, comments, and quotes", () => {
		const parsed = parseDotenv(
			[
				"# a comment",
				"",
				"PLAIN=one",
				"export EXPORTED=two",
				'QUOTED="three  "',
				"SINGLE='four'",
				"TRAILING=five # not part of the value",
				'ESCAPED="line1\\nline2"',
				"WITH_EQUALS=a=b=c",
				"not a pair",
			].join("\n"),
		);
		expect(parsed).toEqual({
			PLAIN: "one",
			EXPORTED: "two",
			QUOTED: "three  ",
			SINGLE: "four",
			TRAILING: "five",
			ESCAPED: "line1\nline2",
			WITH_EQUALS: "a=b=c",
		});
	});
});

describe("loadDotenvFiles — order and precedence", () => {
	it("fills in from .env when nothing is set", () => {
		writeFileSync(join(dir, ".env"), "BLOK_T_A=from-env\n");
		set("BLOK_T_A", undefined);

		expect(loadDotenvFiles(dir)).toEqual([".env"]);
		expect(process.env.BLOK_T_A).toBe("from-env");
	});

	it(".env.local beats .env, and .env still supplies keys .env.local omits", () => {
		writeFileSync(join(dir, ".env"), "BLOK_T_B=from-env\nBLOK_T_B2=only-in-env\n");
		writeFileSync(join(dir, ".env.local"), "BLOK_T_B=from-local\n");
		set("BLOK_T_B", undefined);
		set("BLOK_T_B2", undefined);

		expect(loadDotenvFiles(dir)).toEqual([".env.local", ".env"]);
		expect(process.env.BLOK_T_B).toBe("from-local");
		expect(process.env.BLOK_T_B2).toBe("only-in-env");
	});

	it("the real environment beats every file — a spawned PORT is never clobbered", () => {
		writeFileSync(join(dir, ".env"), "BLOK_T_C=from-env\n");
		writeFileSync(join(dir, ".env.local"), "BLOK_T_C=from-local\n");
		set("BLOK_T_C", "from-shell");

		loadDotenvFiles(dir);
		expect(process.env.BLOK_T_C).toBe("from-shell");
	});

	it("skips .env.local under NODE_ENV=test so local credentials can't leak into a test run", () => {
		writeFileSync(join(dir, ".env"), "BLOK_T_D=from-env\n");
		writeFileSync(join(dir, ".env.local"), "BLOK_T_D=from-local\n");
		set("BLOK_T_D", undefined);
		set("NODE_ENV", "test");

		expect(loadDotenvFiles(dir)).toEqual([".env"]);
		expect(process.env.BLOK_T_D).toBe("from-env");
	});

	it("is a no-op when BLOK_DOTENV_DISABLED=1", () => {
		writeFileSync(join(dir, ".env"), "BLOK_T_E=from-env\n");
		set("BLOK_T_E", undefined);
		set("BLOK_DOTENV_DISABLED", "1");

		expect(loadDotenvFiles(dir)).toEqual([]);
		expect(process.env.BLOK_T_E).toBeUndefined();
	});

	it("is idempotent — a second call does nothing without force", () => {
		writeFileSync(join(dir, ".env"), "BLOK_T_F=first\n");
		set("BLOK_T_F", undefined);
		loadDotenvFiles(dir);

		writeFileSync(join(dir, ".env"), "BLOK_T_F=second\n");
		expect(loadDotenvFiles(dir)).toEqual([]);
		expect(process.env.BLOK_T_F).toBe("first");
	});

	it("tolerates a missing project directory", () => {
		expect(loadDotenvFiles(join(dir, "nope"))).toEqual([]);
	});
});
