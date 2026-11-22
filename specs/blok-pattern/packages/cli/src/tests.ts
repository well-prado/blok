// Running a project's node tests with the project's own test runner.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Paths } from "./analyze.ts";
import { pyprojectSettings } from "./language.ts";
import { pythonCommand } from "./python.ts";

const TEST_FILE = { typescript: /\.test\.[cm]?[jt]s$/, python: /(^|[\\/])(test_[^\\/]*|[^\\/]*_test)\.py$/ };
const NOT_OURS = new Set(["node_modules", "__pycache__", ".venv"]);

/** The test files in a folder, at any depth. */
export function testFiles(paths: Paths, folder: string): string[] {
	if (!existsSync(folder)) return [];
	const pattern = TEST_FILE[paths.language.name];
	return readdirSync(folder, { recursive: true, encoding: "utf8" })
		.filter((file) => pattern.test(file) && !file.split(/[\\/]/).some((part) => NOT_OURS.has(part)))
		.sort()
		.map((file) => join(folder, file));
}

/**
 * The command that runs test files here. In order: `"blok": { "test": "..." }` in package.json,
 * `bun test` in a Bun project, and otherwise Node's own runner. In a Python project: `test = "..."`
 * under [tool.blok], and otherwise pytest, run by the project's own Python.
 */
export function testCommand(paths: Paths): string[] {
	const root = paths.root;
	if (paths.language.name === "python") {
		const configured = pyprojectSettings(root)?.test?.trim();
		return configured ? configured.split(/\s+/) : [...pythonCommand(root), "-m", "pytest", "-q"];
	}
	try {
		const configured = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).blok?.test;
		if (typeof configured === "string" && configured.trim() !== "") return configured.trim().split(/\s+/);
	} catch {}
	const bun =
		"bun" in process.versions ||
		(process.env.npm_config_user_agent ?? "").startsWith("bun") ||
		existsSync(join(root, "bun.lock")) ||
		existsSync(join(root, "bun.lockb"));
	return bun ? ["bun", "test"] : ["node", "--test"];
}

export interface TestRun {
	ok: boolean;
	/** How many tests passed, when the runner's output says so. */
	passed?: number;
	/** The command as it was run, for the report. */
	command: string;
	/** The end of what the runner printed. */
	output: string;
}

/** Runs the given test files and says whether they passed. */
export function runTests(paths: Paths, files: string[]): TestRun {
	const root = paths.root;
	const [command, ...args] = testCommand(paths);
	const run = spawnSync(command, [...args, ...files], { cwd: root, encoding: "utf8" });
	const said = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim().split("\n");
	// Bun prints "3 pass", Node prints "pass 3", pytest prints "3 passed in 0.01s".
	const counted = /^\s*(?:ℹ |# )?(?:(\d+) pass|pass (\d+))\s*$|^=*\s*(\d+) passed\b/m.exec(said.join("\n"));
	return {
		ok: run.status === 0,
		passed: counted ? Number(counted[1] ?? counted[2] ?? counted[3]) : undefined,
		command: [command, ...args].join(" "),
		output: run.error ? `"${command}" could not be run: ${run.error.message}` : excerpt(said),
	};
}

/** The start, where the first failure is explained, and the end, where the runner counts. */
function excerpt(lines: string[]): string {
	if (lines.length <= 48) return lines.join("\n");
	return [...lines.slice(0, 36), `... ${lines.length - 44} lines left out ...`, ...lines.slice(-8)].join("\n");
}

/**
 * The type errors in one folder, according to the project's own TypeScript compiler.
 * A project with no compiler or no tsconfig.json is not checked, and `checked` says so.
 */
export function typeErrors(paths: Paths, folder: string): { checked: boolean; errors: string[] } {
	const root = paths.root;
	// Python's types are checked when the node file is loaded for its contract, and by the kernel at every call.
	if (paths.language.name !== "typescript") return { checked: false, errors: [] };
	const tsc = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
	if (!existsSync(tsc) || !existsSync(join(root, "tsconfig.json"))) return { checked: false, errors: [] };
	const run = spawnSync(tsc, ["--noEmit", "--pretty", "false", "-p", root], { cwd: root, encoding: "utf8" });
	if (run.error) return { checked: false, errors: [] };
	// One line per error, starting with the file. Only this folder's are this node's business.
	const prefix = `${relative(root, folder).split(sep).join("/")}/`;
	return { checked: true, errors: `${run.stdout ?? ""}`.split("\n").filter((line) => line.startsWith(prefix)) };
}
