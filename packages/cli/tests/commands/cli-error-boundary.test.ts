import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * #899 — process-level regression tests for the CLI's single async error
 * boundary (`withErrorBoundary`, packages/cli/src/services/commander.ts).
 *
 * Same shape as cli-action-exit-behavior.test.ts (#896) and for the same
 * reason: a unit test that imports a command function bypasses the commander
 * action wiring entirely, so it passes whether or not the action is awaited and
 * whether or not the failure ever reaches an exit code. These spawn the REAL
 * built CLI.
 *
 * They cover BOTH registration styles, because the boundary has to:
 *   - `check` and `dev` are declared inline in src/index.ts;
 *   - `migrate`, `search`, `gen`, `nodes`, `watch` self-register from
 *     commands/<name>/index.ts via a side-effect import.
 *
 * Needs `bun run build` to have produced `dist/index.js` first (true for the
 * standard `bun run build && bun run test` / CI ordering).
 */
const CLI_DIST = resolve(__dirname, "../../dist/index.js");

/** Bun/Node's raw uncaught-exception dump — never acceptable output. */
function looksLikeCrashDump(output: string): boolean {
	return (
		/Node\.js v\d/.test(output) ||
		/Bun v\d/.test(output) ||
		/\bUnhandledPromiseRejection\b/.test(output) ||
		/\n\s+at \w+ \(/.test(output)
	);
}

function runCli(
	args: string[],
	cwd: string,
	opts: { input?: string; env?: Record<string, string | undefined>; nodeArgs?: string[] } = {},
): SpawnSyncReturns<string> {
	if (!existsSync(CLI_DIST)) {
		throw new Error(`${CLI_DIST} not built — run \`bun run build\` first, then re-run the tests.`);
	}
	const env: Record<string, string | undefined> = { ...process.env, NO_NANOCTL_TELEMETRY: "1", ...opts.env };
	// Never inherit a leftover BLOK_NON_INTERACTIVE from another test file.
	env.BLOK_NON_INTERACTIVE = undefined;
	return spawnSync("node", [...(opts.nodeArgs ?? []), CLI_DIST, ...args], {
		cwd,
		env,
		input: opts.input ?? "",
		encoding: "utf8",
		timeout: 30_000,
	});
}

let workdir: string | undefined;

function emptyProjectDir(prefix: string): string {
	workdir = mkdtempSync(join(tmpdir(), prefix));
	return workdir;
}

afterEach(() => {
	if (workdir) rmSync(workdir, { recursive: true, force: true });
	workdir = undefined;
});

describe("every failing command exits non-zero through the boundary, both registration styles", () => {
	it.each([
		// [label, argv, expected message fragment]
		["check (inline registration)", ["check"], "No .blok/config.json found"],
		["dev (inline registration)", ["dev", "--port", "abc"], 'Invalid port "abc"'],
		["migrate workflows (self-registered)", ["migrate", "workflows"], "Could not find a JSON workflows directory"],
		["search docs (self-registered)", ["search", "docs"], "Question is required"],
		["gen app-types (self-registered)", ["gen", "app-types"], "Could not find a TS workflows directory"],
		[
			"nodes list (self-registered)",
			["nodes", "list", "--url", "http://127.0.0.1:1"],
			"Could not load the node catalog",
		],
		["watch (self-registered)", ["watch", "--url", "http://127.0.0.1:1"], "stream error"],
	])("%s exits 1 with a readable message and no crash dump", (_label, args, fragment) => {
		const dir = emptyProjectDir("blok-cli-boundary-");
		const result = runCli(args as string[], dir);
		const combined = `${result.stdout}${result.stderr}`;

		expect(result.status, `expected exit 1, got ${result.status}. Output:\n${combined}`).toBe(1);
		expect(combined).toContain(fragment as string);
		expect(looksLikeCrashDump(combined), `expected a clean message, got a crash dump:\n${combined}`).toBe(false);
	});
});

describe("the boundary reports the failure once, on stderr", () => {
	it("keeps stdout free of the error message and does not print it twice", () => {
		const dir = emptyProjectDir("blok-cli-boundary-stream-");
		const result = runCli(["check"], dir);
		const message = "No .blok/config.json found. Run this from a Blok project directory.";

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(message);
		expect(result.stdout).not.toContain(message);
		expect(result.stderr.split(message).length - 1).toBe(1);
	});
});

describe("a cancelled command is not a failure", () => {
	it("clack cancel (Ctrl-C at a prompt) still exits 0", () => {
		const dir = emptyProjectDir("blok-cli-boundary-cancel-");
		// Closed stdin is what clack reads as a cancel here; its onCancel handler
		// is one of the process.exit sites the sweep deliberately keeps, and it
		// must stay a clean exit 0 rather than being turned into a failure.
		const result = runCli(["create", "workflow"], dir, { input: "" });
		const combined = `${result.stdout}${result.stderr}`;

		expect(result.status, `expected exit 0 on cancel, got ${result.status}. Output:\n${combined}`).toBe(0);
		expect(combined).toContain("Operation canceled");
	});
});

describe("a failed command drains the event loop instead of force-exiting", () => {
	/**
	 * `beforeExit` is the discriminator, and it is the reason this change
	 * matters at all: Node does not emit it "for conditions causing explicit
	 * termination, such as calling process.exit()". A command that exits itself
	 * therefore skips every pending continuation — including posthog's async
	 * flush, whose `exit` registration in services/posthog.ts fires either way
	 * but whose in-flight HTTP request does not survive the teardown.
	 *
	 * Measured against the pre-#899 build: none of these commands emitted the
	 * marker (each force-exited); all of them do now.
	 */
	const HOOKS =
		'process.on("beforeExit", () => process.stderr.write("\\n__DRAINED__\\n"));\n' +
		'process.on("exit", () => process.stderr.write("\\n__EXIT_HOOK_RAN__\\n"));\n';

	it.each([
		["check (inline registration)", ["check"]],
		["dev (inline registration; its un-awaited action was fixed alongside)", ["dev", "--port", "abc"]],
		["migrate workflows (self-registered)", ["migrate", "workflows"]],
		["search docs (self-registered)", ["search", "docs"]],
		["watch (self-registered)", ["watch", "--url", "http://127.0.0.1:1"]],
	])("%s reaches beforeExit, and still exits 1", (_label, args) => {
		const dir = emptyProjectDir("blok-cli-boundary-drain-");
		const hook = join(dir, "exit-hooks.cjs");
		writeFileSync(hook, HOOKS);

		const result = runCli(args as string[], dir, { nodeArgs: ["--require", hook] });
		const combined = `${result.stdout}${result.stderr}`;

		expect(result.status, `expected exit 1, got ${result.status}. Output:\n${combined}`).toBe(1);
		expect(combined, `command force-exited instead of draining:\n${combined}`).toContain("__DRAINED__");
		expect(combined).toContain("__EXIT_HOOK_RAN__");
	});

	it("still exits 1 with telemetry enabled — the posthog exit flush neither hangs nor masks the code", () => {
		const dir = emptyProjectDir("blok-cli-boundary-telemetry-");
		const hook = join(dir, "exit-hooks.cjs");
		writeFileSync(hook, HOOKS);

		const result = runCli(["check"], dir, {
			nodeArgs: ["--require", hook],
			env: { NO_NANOCTL_TELEMETRY: undefined },
		});
		const combined = `${result.stdout}${result.stderr}`;

		expect(result.status, `expected exit 1, got ${result.status}. Output:\n${combined}`).toBe(1);
		expect(combined).toContain("__EXIT_HOOK_RAN__");
		expect(combined).toContain("No .blok/config.json found");
	});
});
