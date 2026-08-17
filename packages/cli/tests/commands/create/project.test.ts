import os from "node:os";
import path from "node:path";
import fsExtra from "fs-extra";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createProject } from "../../../src/commands/create/project";

/**
 * `createProject` never rejects once it is past flag resolution: the catch at
 * the end of src/commands/create/project.ts turns every internal failure into
 * `process.exitCode = 1`. Awaiting the promise is therefore necessary but not
 * sufficient — `resolves.not.toThrow()` on its own still passes on a scaffold
 * that blew up halfway. Assert the two outcomes that ARE observable: a clean
 * exit code, and a project directory that actually landed.
 *
 * The 4th argument is the `--local` repo path, so the package manager resolves
 * @blokjs/* through `file:` links in this monorepo. Without it createProject
 * git-clones the release tag into ~/.blok/blok — removing whatever is already
 * there — and then installs `^undefined` ranges from the registry.
 *
 * The scaffold goes into a tmpdir, never into packages/cli itself: see the
 * note in project-non-interactive.test.ts for what a `file:` self-reference
 * does to a scaffold nested inside the package it depends on.
 */
const REPO_ROOT = path.resolve(__dirname, "../../../../..");

const origCwd = process.cwd();
let workDir: string;

beforeEach(() => {
	workDir = fsExtra.mkdtempSync(path.join(os.tmpdir(), "blok-create-"));
	process.chdir(workDir);
	process.exitCode = undefined;
});

afterEach(() => {
	// A swallowed failure must not leak into vitest's own exit code.
	process.exitCode = undefined;
	process.chdir(origCwd);
	fsExtra.removeSync(workDir);
});

test("create project", async () => {
	await createProject({ name: "default-node", packageManager: "npm" }, "0.0.0-test", false, REPO_ROOT);

	expect(process.exitCode).not.toBe(1);
	expect(fsExtra.existsSync(path.join(workDir, "default-node", "package.json"))).toBe(true);
}, 120_000);

test("create path", async () => {
	const env = "WORKFLOWS_PATH=PROJECT_PATH/workflows,NODES_PATH=PROJECT_PATH/src/nodes";
	const path = "/home/ubuntu";
	const result = env.replaceAll("PROJECT_PATH", path);

	expect(result).toBe("WORKFLOWS_PATH=/home/ubuntu/workflows,NODES_PATH=/home/ubuntu/src/nodes");
});
