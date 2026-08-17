import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * #669 — dev fixtures the scaffold's copy filter must never ship. Copied
 * verbatim they look like working examples (they declare routes) but only
 * register via the http trigger's OWN in-repo Workflows.ts, which scaffolds
 * don't ship — so they'd 500 on first request. See the `devFixtures` regex
 * in `packages/cli/src/commands/create/project.ts`.
 */
const DEV_FIXTURE_PATHS = [
	"src/workflows/http/countries-helper.ts",
	"src/workflows/http/countries-cats-helper.ts",
	"src/workflows/http/empty.ts",
	"src/workflows/http/eval/eval-run.ts",
	"src/workflows/http/eval/eval-retrieve.ts",
	"src/workflows/http/eval/foreign-auth.ts",
];

/**
 * #733 — real build+boot regression for the default HTTP scaffold.
 *
 * Every OTHER scaffold test in this package (`handle-dsl-workflow.test.ts`,
 * `pubsub-scaffold.test.ts`, etc.) only asserts on generated source TEXT —
 * none of them ever actually `npm install && npm run build && node dist/…`
 * a scaffold. That gap is exactly why #733 shipped invisibly: `blokctl
 * create --local . && npm run build && npm run start` logged
 * `[blok] route collision — Two workflows claim GET /countries-dsl` on
 * EVERY fresh HTTP scaffold's first boot. Root cause: `Workflows.ts`
 * compiles to `dist/` and imports the COMPILED `countries-handle-dsl.js`,
 * while the TS auto-routing scanner (hard-coded to `<cwd>/src/workflows`
 * SOURCE) dynamic-imports the `.ts` file directly under Node's native TS
 * stripping (22.6+) — two different module instances of the same workflow,
 * so the old `===` dedup in `WorkflowRouter.buildRouteTable` missed it.
 *
 * This test closes that class: it drives the REAL `blokctl create` CLI,
 * builds the scaffold with ITS OWN `tsc` (not the monorepo's), and boots
 * the compiled entry under plain `node` (not `bun run` / ts-node) — the
 * exact repro shape from the issue. Zero "route collision" lines is the
 * assertion; a regression here would have caught #733 before it shipped.
 *
 * Extended for #669 (same real-boot rig, `--examples` added to the scaffold
 * flags): asserts the dev-fixture exclusion above, that an unknown path
 * 404s instead of falling through the legacy catch-all to a 500, and that
 * a shipped TS example workflow is actually routed and reachable.
 *
 * SLOW + needs network (a real `npm install`) — opt in with
 * `BLOK_INTEGRATION_SCAFFOLD_BOOT=1`. Skipped otherwise, same convention
 * as the other `real-*`-gated integration suites in this monorepo.
 */

const REPO_ROOT = resolve(__dirname, "../../../..");
const CLI_DIST = join(REPO_ROOT, "packages/cli/dist/index.js");
const RUN_GATE = process.env.BLOK_INTEGRATION_SCAFFOLD_BOOT === "1";
const d = RUN_GATE ? describe : describe.skip;

let workdir: string | undefined;

afterAll(() => {
	if (workdir) rmSync(workdir, { recursive: true, force: true });
});

d("HTTP scaffold — real build + boot under plain Node (#733, #669)", () => {
	it("blokctl create --local . --examples && npm run build && npm run start ships no dev fixtures, 404s on unknown paths, and logs ZERO route-collision lines", async () => {
		if (!existsSync(CLI_DIST)) {
			throw new Error(
				`${CLI_DIST} not built — run \`bun run build\` first (the packaging/fast CI lanes do this already).`,
			);
		}

		workdir = mkdtempSync(join(tmpdir(), "blok-http-scaffold-boot-"));
		const projectName = "http-boot-smoke";
		const projectDir = join(workdir, projectName);

		// 1. Scaffold with the REAL CLI, --local so @blokjs/* resolve to this
		//    checkout's own dist instead of the npm registry.
		execFileSync(
			"bun",
			[
				CLI_DIST,
				"create",
				"project",
				"--name",
				projectName,
				"--local",
				REPO_ROOT,
				"--triggers",
				"http",
				"--package-manager",
				"npm",
				"--non-interactive",
				"--examples",
			],
			{
				cwd: workdir,
				stdio: "pipe",
				timeout: 120_000,
			},
		);
		expect(existsSync(projectDir)).toBe(true);

		// #669 (shipping half) — none of the http trigger's own dev/test
		// fixtures made it into the scaffold.
		for (const rel of DEV_FIXTURE_PATHS) {
			expect(existsSync(join(projectDir, rel)), `${rel} should NOT be shipped by the scaffold`).toBe(false);
		}

		// 2. Build with the SCAFFOLD's own tsc (not the monorepo's) — this is
		//    the exact step that compiles Workflows.ts to dist/ and produces
		//    the dist-vs-src double module instance #733 is about. `tsc`'s
		//    default noEmitOnError:false still writes dist/ even on a type
		//    error, so a build that reports errors from unrelated template
		//    issues doesn't block this boot check — only route-collision
		//    lines at BOOT are asserted below.
		execFileSync("npm", ["run", "build"], { cwd: projectDir, stdio: "pipe", timeout: 120_000 });
		const entry = join(projectDir, "dist/triggers/http/index.js");
		expect(existsSync(entry)).toBe(true);

		// 3. Boot the COMPILED entry under plain `node` — not `bun run`, not
		//    ts-node. This is the one condition #733's root cause needs: Node's
		//    native TS stripping (22.6+) is what lets the scanner import the
		//    `.ts` SOURCE successfully as a second module instance.
		const port = 41000 + Math.floor(Math.random() * 4000);
		const boot = spawn("node", [entry], {
			cwd: projectDir,
			env: { ...process.env, PORT: String(port), DISABLE_TRIGGER_RUN: "false" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		boot.stdout.on("data", (c) => {
			output += c.toString();
		});
		boot.stderr.on("data", (c) => {
			output += c.toString();
		});

		try {
			// Poll for health rather than a fixed sleep — bounded retry, no long sleep.
			let healthy = false;
			let lastStatus: number | undefined;
			for (let i = 0; i < 30 && !healthy; i++) {
				try {
					const res = await fetch(`http://localhost:${port}/health-check`);
					lastStatus = res.status;
					healthy = res.ok;
				} catch {
					// server not up yet
				}
				if (!healthy) await new Promise((r) => setTimeout(r, 500));
			}
			expect(healthy, `health-check never returned 2xx (last status: ${lastStatus}). Boot output:\n${output}`).toBe(
				true,
			);
			expect(lastStatus).toBe(200);

			// #669 (catch-all half) — an unknown path is resource-not-found (404),
			// never the legacy catch-all's 500.
			const unknownRes = await fetch(`http://localhost:${port}/this-path-does-not-exist-at-all`);
			expect(unknownRes.status).toBe(404);

			// Also true for the excluded dev-fixture paths above: even if a future
			// regression re-ships one of them, hitting it must 404, not 500.
			const devFixtureRes = await fetch(`http://localhost:${port}/countries-helper`);
			expect(devFixtureRes.status).toBe(404);

			// #669 — every shipped workflow is registered and reachable. The
			// typed-handle DSL example (`src/workflows/http/countries-handle-dsl.ts`,
			// declares `http.get("/countries-dsl")`) ships with every HTTP scaffold
			// and is auto-routed by the TS file-based scan — no manual
			// `Workflows.ts` entry required. Confirms it isn't a shipped-but-dead
			// file like the excluded fixtures above.
			const exampleRes = await fetch(`http://localhost:${port}/countries-dsl`);
			expect(exampleRes.status, "the countries-dsl example route must resolve to a real workflow").not.toBe(404);
		} finally {
			boot.kill("SIGTERM");
		}

		expect(output).not.toContain("route collision");
		// #669 — the file-based scanner found every shipped workflow's HTTP
		// trigger a route; nothing was silently orphaned.
		expect(output).not.toContain("declares an HTTP trigger but produced no route");
		expect(output).not.toContain("workflow(s) dropped due to route collisions");
	}, 180_000);
});
