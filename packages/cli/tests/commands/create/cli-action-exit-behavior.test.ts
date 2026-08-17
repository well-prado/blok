import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * #888 / #890 — real process-level regression tests.
 *
 * `createNode`/`createProject`/`createWorkflow` unit tests that import the
 * function directly (node-non-interactive.test.ts, project-non-interactive.test.ts,
 * …) bypass the commander action-wiring in `src/index.ts` entirely, so they
 * pass identically whether or not the six `create *` actions `await` their
 * implementation and whether `process.parse`/`parseAsync` is used. That gap
 * is exactly why neither bug had a failing test. These tests spawn the REAL
 * built CLI so the actual `.action(async (options) => …)` registrations are
 * what get exercised — same repro shape as both GitHub issues.
 *
 * Needs `bun run build` to have produced `dist/index.js` first (true for the
 * standard `bun run build && bun run test` / CI ordering).
 */
const CLI_DIST = resolve(__dirname, "../../../dist/index.js");

function runCli(args: string[], cwd: string): SpawnSyncReturns<string> {
	if (!existsSync(CLI_DIST)) {
		throw new Error(`${CLI_DIST} not built — run \`bun run build\` first, then re-run the tests.`);
	}
	const env = { ...process.env, NO_NANOCTL_TELEMETRY: "1" };
	// Force the flag-driven non-interactive path only — never inherit a
	// leftover BLOK_NON_INTERACTIVE from another test file in this run.
	env.BLOK_NON_INTERACTIVE = undefined;
	return spawnSync("node", [CLI_DIST, ...args], {
		cwd,
		env,
		encoding: "utf8",
		timeout: 20_000,
	});
}

/** Bun/Node's raw uncaught-exception dump: file:// frame, `throw`/`^` source
 * excerpt, `    at <fn> (...)` stack lines, runtime version banner. None of
 * that should ever reach the user once the action is properly awaited and
 * caught. */
function looksLikeCrashDump(output: string): boolean {
	return /\n\s+at resolveOrThrow/.test(output) || /Node\.js v\d/.test(output) || /Bun v\d/.test(output);
}

let workdir: string | undefined;

afterEach(() => {
	if (workdir) rmSync(workdir, { recursive: true, force: true });
	workdir = undefined;
});

describe("create action CLI wiring — non-interactive flag validation (#890)", () => {
	it.each([
		["project", ["create", "project", "--non-interactive"]],
		["node", ["create", "node", "--non-interactive"]],
		["workflow", ["create", "workflow", "--non-interactive"]],
	])(
		"create %s --non-interactive without --name exits non-zero with a clean message, no crash dump",
		(_label, args) => {
			workdir = mkdtempSync(join(tmpdir(), "blok-cli-non-interactive-"));
			const result = runCli(args, workdir);
			const combined = `${result.stdout}${result.stderr}`;

			expect(result.status, `expected non-zero exit, got 0. Output:\n${combined}`).not.toBe(0);
			expect(combined).toContain("Missing required flag --name (non-interactive mode)");
			expect(looksLikeCrashDump(combined), `expected a clean message, got a crash dump:\n${combined}`).toBe(false);
		},
	);
});

describe("create node — failing template/step exits non-zero (#888)", () => {
	it("create node --name <x> --non-interactive outside a scaffolded project exits non-zero with a message", () => {
		workdir = mkdtempSync(join(tmpdir(), "blok-cli-node-failure-"));
		// No `~/.blok/blok` clone and/or no `src/` in this fresh cwd — either
		// way createNode's try block throws (the exact repro from #888's
		// issue body: `blokctl create node --name probe-node --non-interactive`
		// from an empty directory used to print the error and exit 0).
		const result = runCli(["create", "node", "--name", "probe-node", "--non-interactive"], workdir);
		const combined = `${result.stdout}${result.stderr}`;

		expect(result.status, `expected non-zero exit, got 0. Output:\n${combined}`).not.toBe(0);
		expect(combined.length).toBeGreaterThan(0);
		expect(looksLikeCrashDump(combined), `expected a clean message, got a crash dump:\n${combined}`).toBe(false);
	});
});

describe("create workflow — same swallowed-failure shape as #888, fixed alongside it", () => {
	it("create workflow --name <x> --non-interactive outside a scaffolded project exits non-zero with a message", () => {
		workdir = mkdtempSync(join(tmpdir(), "blok-cli-workflow-failure-"));
		const result = runCli(["create", "workflow", "--name", "probe-workflow", "--non-interactive"], workdir);
		const combined = `${result.stdout}${result.stderr}`;

		expect(result.status, `expected non-zero exit, got 0. Output:\n${combined}`).not.toBe(0);
		expect(combined.length).toBeGreaterThan(0);
		expect(looksLikeCrashDump(combined), `expected a clean message, got a crash dump:\n${combined}`).toBe(false);
	});
});
