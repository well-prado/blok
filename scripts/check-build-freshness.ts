#!/usr/bin/env bun
/**
 * Does `bun run build` actually rebuild what I just edited? (#1067)
 *
 * The failure this exists for: `nx run-many -t build` hashes each task from
 * the project file map the **nx daemon** keeps, and the daemon maintains that
 * map from a filesystem WATCHER. A source file edited inside the watcher's
 * latency window — most likely right after a big build, when the daemon is
 * chewing through thousands of `dist/` events — is hashed at its OLD content.
 * Same hash, cache hit, task skipped, `dist/` left as it was. The build says
 * "Successfully ran target build for 33 projects" and a test run against that
 * `dist` is a green that means nothing. `bunx nx reset` "fixed" it by killing
 * the daemon and the cache together, which is why it looked like a cache bug.
 *
 * The repo's fix is `"useDaemonProcess": false` in `nx.json`: nx then computes
 * the file map itself on every invocation, so the hash always reflects what is
 * on disk. Cost, measured on this workspace, ~0.5s per fully-cached build.
 *
 * This script is the check that the fix is still working, end to end:
 *
 *   1. self-check — run the cycle with a build command that does NOTHING and
 *      assert it is reported as stale (a detector that cannot fail is not a
 *      detector);
 *   2. the real thing — edit a source file, run the real build, assert `dist`
 *      carries the edit; then restore the file and rebuild.
 *
 *   bun run build:check
 *
 * If it fails, the recovery is `bunx nx reset` (clears the nx cache and stops
 * the daemon), then `bun run build`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** A leaf package: rebuilding it drags the fewest other projects along. */
const SOURCE = "packages/auth/src/config.ts";
const BUILT = "packages/auth/dist/config.js";

const MARKER = `BLOK_BUILD_FRESHNESS_${Date.now()}`;

function build(command: string): void {
	const [bin, ...args] = command.split(" ");
	const run = spawnSync(bin, args, { cwd: ROOT, stdio: "inherit" });
	if (run.status !== 0) throw new Error(`\`${command}\` exited ${run.status}`);
}

/** Append `marker` to the source, build, and report whether `dist` picked it up. */
function distReflectsAnEdit(command: string): boolean {
	const source = join(ROOT, SOURCE);
	const original = readFileSync(source, "utf8");
	try {
		writeFileSync(source, `${original}\nexport const ${MARKER} = true;\n`);
		build(command);
		return readFileSync(join(ROOT, BUILT), "utf8").includes(MARKER);
	} finally {
		writeFileSync(source, original);
	}
}

console.log("\n▶ self-check: a build that does nothing must be reported as stale");
if (distReflectsAnEdit("true")) {
	console.error(`✖ ${BUILT} contains ${MARKER} after a no-op build — this check cannot detect staleness.`);
	process.exitCode = 1;
} else {
	console.log("✔ the check fails when the build does not run");
}

console.log(`\n▶ edit ${SOURCE} → bun run build → is it in ${BUILT}?`);
if (!distReflectsAnEdit("bun run build")) {
	console.error(
		[
			`✖ ${BUILT} does NOT contain the edit that was just made to ${SOURCE}.`,
			"  nx served a cached dist for inputs that had already changed, so every test,",
			"  scaffold and packaging gate reading that dist is testing the previous build.",
			"  Recovery: `bunx nx reset` (stops the daemon, clears the cache), then `bun run build`.",
			'  Check that `nx.json` still has `"useDaemonProcess": false` (#1067).',
		].join("\n"),
	);
	process.exitCode = 1;
} else {
	console.log("✔ dist reflects the edit");
}

// Leave dist matching the restored sources.
build("bun run build");
console.log(process.exitCode ? "\n✖ build freshness check FAILED" : "\n✅ build freshness check passed");
