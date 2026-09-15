import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileLinkDirs, findStaleDists, formatStaleDistWarning } from "./local-dist-freshness.js";

const roots: string[] = [];

/** A package dir with a `src/` file, and a `dist/` file when `builtAt` is given. */
function pkg(name: string, { srcAt, builtAt }: { srcAt: number; builtAt?: number }): string {
	const root = mkdtempSync(join(tmpdir(), "blok-freshness-"));
	roots.push(root);
	const dir = join(root, name);
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src/index.ts"), "export const x = 1;\n");
	utimesSync(join(dir, "src/index.ts"), srcAt, srcAt);
	if (builtAt !== undefined) {
		mkdirSync(join(dir, "dist"), { recursive: true });
		writeFileSync(join(dir, "dist/index.js"), "export const x = 1;\n");
		utimesSync(join(dir, "dist/index.js"), builtAt, builtAt);
	}
	return dir;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("findStaleDists", () => {
	it("flags a package whose src is newer than its dist", () => {
		const dir = pkg("edited", { srcAt: 2_000_000, builtAt: 1_000_000 });
		expect(findStaleDists([dir])).toEqual([{ dir, neverBuilt: false }]);
	});

	it("flags a package that was never built", () => {
		const dir = pkg("unbuilt", { srcAt: 1_000_000 });
		expect(findStaleDists([dir])).toEqual([{ dir, neverBuilt: true }]);
	});

	it("says nothing about a package built after its last edit", () => {
		expect(findStaleDists([pkg("fresh", { srcAt: 1_000_000, builtAt: 2_000_000 })])).toEqual([]);
	});

	it("ignores a linked directory that has no src/ (a published package)", () => {
		const root = mkdtempSync(join(tmpdir(), "blok-freshness-"));
		roots.push(root);
		mkdirSync(join(root, "dist"), { recursive: true });
		writeFileSync(join(root, "dist/index.js"), "export const x = 1;\n");
		expect(findStaleDists([root])).toEqual([]);
	});

	it("checks each directory once even when several deps link to it", () => {
		const dir = pkg("shared", { srcAt: 2_000_000, builtAt: 1_000_000 });
		expect(findStaleDists([dir, dir, dir])).toHaveLength(1);
	});
});

describe("fileLinkDirs", () => {
	it("collects file: targets from every dependency group", () => {
		expect(
			fileLinkDirs({
				dependencies: { "@blokjs/runner": "file:/repo/core/runner", hono: "^4.0.0" },
				devDependencies: { blokctl: "file:/repo/packages/cli" },
				overrides: { "@blokjs/shared": "file:/repo/core/shared" },
				scripts: { build: "tsc" },
			}),
		).toEqual(["/repo/core/runner", "/repo/packages/cli", "/repo/core/shared"]);
	});

	it("is empty for a scaffold that resolves from npm", () => {
		expect(fileLinkDirs({ dependencies: { "@blokjs/runner": "^2.3.0" } })).toEqual([]);
	});
});

describe("formatStaleDistWarning", () => {
	it("names every stale package and the recovery", () => {
		const message = formatStaleDistWarning(
			[
				{ dir: "/repo/core/runner", neverBuilt: false },
				{ dir: "/repo/packages/auth", neverBuilt: true },
			],
			"/repo",
		);
		expect(message).toContain("/repo/core/runner");
		expect(message).toContain("/repo/packages/auth (never built)");
		expect(message).toContain("bun run build");
		expect(message).toContain("bunx nx reset");
	});
});
