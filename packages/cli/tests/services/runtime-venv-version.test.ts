import os from "node:os";
import path from "node:path";
import fsExtra from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateProjectRuntimes } from "../../src/services/runtime-setup.js";

/**
 * The python3 sidecar boots with `.blok/runtimes/python3/python3_runtime/bin/python3`,
 * so `blokctl dev` / `blokctl check` must version-check THAT interpreter, not
 * the first `python3` on PATH (macOS ships 3.9, which forced
 * `--skip-version-check`). A fake venv interpreter keeps this host-independent.
 */
describe("validateProjectRuntimes — python3 venv", () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = fsExtra.mkdtempSync(path.join(os.tmpdir(), "blok-venv-"));
		const cwd = path.join(".blok", "runtimes", "python3");
		const venvPython = path.join(projectDir, cwd, "python3_runtime", "bin", "python3");
		fsExtra.outputFileSync(venvPython, "#!/bin/sh\necho 'Python 3.99.1'\n");
		fsExtra.chmodSync(venvPython, 0o755);
		fsExtra.outputJsonSync(path.join(projectDir, ".blok", "config.json"), {
			runtimes: {
				python3: {
					kind: "python3",
					label: "Python 3",
					cwd,
					port: 9007,
					startCmd: "python3_runtime/bin/python3 bin/serve.py",
					requiredVersion: ">=3.99.0",
				},
			},
		});
	});

	afterEach(() => {
		fsExtra.removeSync(projectDir);
	});

	it("checks the venv interpreter's version", async () => {
		const [result] = await validateProjectRuntimes(projectDir);
		expect(result).toMatchObject({ kind: "python3", found: "3.99.1", satisfied: true });
	});
});
