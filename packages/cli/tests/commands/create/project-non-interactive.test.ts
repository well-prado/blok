import path from "node:path";
import fsExtra from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject } from "../../../src/commands/create/project";
import { setNonInteractive } from "../../../src/services/non-interactive.js";

/**
 * `createProject` never rejects once it is past flag resolution: the catch at
 * the end of src/commands/create/project.ts turns every internal failure into
 * `process.exitCode = 1`. Awaiting the promise is therefore necessary but not
 * sufficient — `resolves.not.toThrow()` on its own still passes on a scaffold
 * that blew up halfway. `scaffold()` awaits the call (a flag that fell through
 * to an interactive prompt would hang and time out) and asserts the two
 * outcomes that ARE observable: a clean exit code, and a project directory
 * that actually landed.
 *
 * The 4th argument is the `--local` repo path, so the package manager resolves
 * @blokjs/* through `file:` links in this monorepo. Without it createProject
 * git-clones the release tag into ~/.blok/blok — removing whatever is already
 * there — and then installs `^undefined` ranges from the registry.
 */
const REPO_ROOT = path.resolve(__dirname, "../../../../..");

// A real scaffold runs a real `npm install`, so the package default 30s is not
// enough headroom on a cold runner.
const SCAFFOLD_TIMEOUT = 120_000;

describe("create project (non-interactive)", () => {
	const created: string[] = [];

	beforeEach(() => {
		setNonInteractive(true);
		process.exitCode = undefined;
	});

	afterEach(() => {
		setNonInteractive(false);
		// A swallowed failure must not leak into vitest's own exit code.
		process.exitCode = undefined;
		for (const dir of created.splice(0)) {
			fsExtra.removeSync(dir);
		}
	});

	async function scaffold(name: string, opts: Record<string, string> = {}) {
		const dir = path.join(process.cwd(), name);
		created.push(dir);
		await createProject({ name, packageManager: "npm", ...opts }, "0.0.0-test", false, REPO_ROOT);

		expect(process.exitCode).not.toBe(1);
		expect(fsExtra.existsSync(path.join(dir, "package.json"))).toBe(true);
	}

	it(
		"should not throw when name is provided in non-interactive mode",
		async () => {
			await scaffold("test-ni-project");
		},
		SCAFFOLD_TIMEOUT,
	);

	it("should throw when name is missing in non-interactive mode", async () => {
		await expect(createProject({})).rejects.toThrow("Missing required flag --name (non-interactive mode)");
	});

	it(
		"should accept trigger flag in non-interactive mode",
		async () => {
			await scaffold("test-ni-trigger", { trigger: "http" });
		},
		SCAFFOLD_TIMEOUT,
	);

	it(
		"should accept runtimes flag in non-interactive mode",
		async () => {
			await scaffold("test-ni-runtimes", { runtimes: "node" });
		},
		SCAFFOLD_TIMEOUT,
	);

	it(
		"should accept package-manager flag in non-interactive mode",
		async () => {
			await scaffold("test-ni-pm", { packageManager: "bun" });
		},
		SCAFFOLD_TIMEOUT,
	);

	// Bug 02: a worker scaffold with no --queue-provider must resolve without
	// throwing (no broker is hardcoded → in-memory default boots clean). The
	// adapter/env/dep substance is asserted deterministically in
	// worker-scaffold.test.ts; this guards the non-interactive entrypoint.
	it(
		"should accept http,worker triggers without a queue-provider",
		async () => {
			await scaffold("test-ni-http-worker", { triggers: "http,worker" });
		},
		SCAFFOLD_TIMEOUT,
	);
});
