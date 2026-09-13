import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");

/** The workspace's own tsc — never a network-resolved one. */
function tscBin(): string {
	let dir = packageRoot;
	for (;;) {
		const candidate = join(dir, "node_modules", ".bin", "tsc");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) throw new Error("no local tsc found");
		dir = parent;
	}
}

function typecheck(fixture: string): { ok: boolean; output: string } {
	const result = spawnSync(tscBin(), ["--noEmit", "-p", join(here, "fixtures", fixture)], {
		encoding: "utf8",
		cwd: packageRoot,
	});
	return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("framework fixtures", () => {
	// Each fixture is typed against the shared generated-types stand-in
	// (tests/fixtures/blok-generated.d.ts) and uses the stock adapter hooks.
	for (const fixture of ["react", "vue", "svelte"]) {
		it(`${fixture} page components typecheck`, () => {
			const { ok, output } = typecheck(fixture);
			expect(output).toBe("");
			expect(ok).toBe(true);
		}, 60_000);
	}

	it("rejects unknown pages, unknown routes, missing params and prop typos", () => {
		// Every misuse is marked `@ts-expect-error`, so this fixture compiles
		// clean iff all of them really are errors.
		const { ok, output } = typecheck("negative");
		expect(output).toBe("");
		expect(ok).toBe(true);
	}, 60_000);
});
