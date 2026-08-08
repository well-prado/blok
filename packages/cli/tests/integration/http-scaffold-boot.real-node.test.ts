import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

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

d("HTTP scaffold — real build + boot under plain Node (#733)", () => {
	it("blokctl create --local . && npm run build && npm run start logs ZERO route-collision lines and health-checks 200", async () => {
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
			],
			{
				cwd: workdir,
				stdio: "pipe",
				timeout: 120_000,
			},
		);
		expect(existsSync(projectDir)).toBe(true);

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
		} finally {
			boot.kill("SIGTERM");
		}

		expect(output).not.toContain("route collision");
		expect(output).not.toContain("workflow(s) dropped due to route collisions");
	}, 180_000);
});
