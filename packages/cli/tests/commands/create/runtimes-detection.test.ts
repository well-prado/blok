import os from "node:os";
import path from "node:path";
import fsExtra from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `blokctl create project --name x --runtimes node,python3` (no `--yes`) skips
 * the prompts because `--name` is set, but is NOT non-interactive — so neither
 * detection branch ran, `detectedRuntimes` stayed empty, and python3 was
 * silently dropped at setup (`if (!rt) continue`). Detection throws a sentinel
 * here so the test proves it runs without paying for a real scaffold.
 */
vi.mock("../../../src/services/runtime-detector.js", async (orig) => {
	const actual = await orig<typeof import("../../../src/services/runtime-detector.js")>();
	return {
		...actual,
		detectRuntimes: vi.fn(async () => {
			throw new Error("detectRuntimes called");
		}),
	};
});

import { createProject } from "../../../src/commands/create/project";

// `--local` so a regression scaffolds from this repo instead of re-cloning
// (and first deleting) the ~/.blok/blok cache.
const REPO_ROOT = path.resolve(__dirname, "../../../../..");

describe("create project — runtime detection with --name but prompts on", () => {
	const origCwd = process.cwd();
	let workDir: string;

	beforeEach(() => {
		workDir = fsExtra.mkdtempSync(path.join(os.tmpdir(), "blok-create-rt-"));
		process.chdir(workDir);
	});

	afterEach(() => {
		process.chdir(origCwd);
		fsExtra.removeSync(workDir);
	});

	it("detects runtimes when a non-node runtime is requested", async () => {
		await expect(createProject({ name: "rt-detect", packageManager: "npm", runtimes: "node,python3" })).rejects.toThrow(
			"detectRuntimes called",
		);
	});
});
