/**
 * `blokctl inertia doctor` (#1019, test 3).
 *
 * Two fixtures: `inertia-doctor` is wired correctly, `inertia-doctor-broken`
 * is wrong in five ways at once (component missing from the client, custom
 * shell without `<!--blok:head-->`, no `inertia.csrf`, no asset version, no
 * Vite descriptor). The env is injected rather than mutated, so the checks
 * are exercised in both directions without a global `process.env` dance.
 *
 * The last case runs the REAL command through the built CLI, because the thing
 * under test there is the exit status.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type DoctorCheck, inertiaDoctor } from "../../../src/commands/inertia/doctor.js";

const FIXTURES = resolve(__dirname, "../../fixtures");
const HEALTHY = join(FIXTURES, "inertia-doctor");
const BROKEN = join(FIXTURES, "inertia-doctor-broken");
const CLI_DIST = resolve(__dirname, "../../../dist/index.js");

/** Everything a healthy run needs. Inherit nothing — the point is the checks. */
function healthyEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	return {
		NODE_ENV: "development",
		BLOK_FLASH_SECRET: "test-flash-secret",
		BLOK_SESSION_SECRET: "test-session-secret",
		BLOK_STATIC_DIR: join(HEALTHY, "client-build"),
		...overrides,
	} as NodeJS.ProcessEnv;
}

/**
 * The fixtures' client build directory is `client-build`, NOT `client/dist`:
 * the repo's .gitignore swallows `dist` (and `out`) at any depth, so a fixture
 * under either name is present locally and absent in CI — which is exactly how
 * this bit once. This guard makes that mistake loud instead of subtle.
 */
function assertFixtureCommitted(dir: string): void {
	for (const file of ["package.json", "src/workflows/dashboard.ts", "client-build/pages.json"]) {
		if (!existsSync(join(dir, file))) throw new Error(`fixture file missing (git-ignored?): ${join(dir, file)}`);
	}
}

function find(checks: DoctorCheck[], name: string): DoctorCheck {
	const check = checks.find((candidate) => candidate.name === name);
	if (!check) throw new Error(`no check named ${name} in: ${checks.map((c) => c.name).join(", ")}`);
	return check;
}

describe("inertia doctor — the healthy fixture", () => {
	it("ships both fixtures — every file tracked, none git-ignored", () => {
		assertFixtureCommitted(HEALTHY);
		assertFixtureCommitted(BROKEN);
		expect(existsSync(join(HEALTHY, "client-build/.blok-asset-version"))).toBe(true);
		expect(existsSync(join(HEALTHY, "client-build/.blok-vite.json"))).toBe(true);
		// The broken fixture deliberately has NO asset version or Vite descriptor.
		expect(existsSync(join(BROKEN, "client-build/.blok-asset-version"))).toBe(false);
		expect(existsSync(join(BROKEN, "client-build/.blok-vite.json"))).toBe(false);
	});

	it("passes every check", async () => {
		const checks = await inertiaDoctor({ cwd: HEALTHY, env: healthyEnv() });
		expect(checks.filter((check) => check.status === "fail")).toEqual([]);
		expect(find(checks, "shell markers").status).toBe("ok");
		expect(find(checks, "ensurePagesExist").status).toBe("ok");
		expect(find(checks, "inertia.csrf").status).toBe("ok");
		expect(find(checks, "ASSET_VERSION").status).toBe("ok");
		expect(find(checks, ".blok-vite.json").status).toBe("ok");
		// SSR is not configured here, so it is skipped rather than failed.
		expect(find(checks, "SSR").status).toBe("skip");
	}, 60_000);

	it("fails on a missing BLOK_FLASH_SECRET, naming the variable in the Fix line", async () => {
		const checks = await inertiaDoctor({ cwd: HEALTHY, env: healthyEnv({ BLOK_FLASH_SECRET: undefined }) });
		const secret = find(checks, "BLOK_FLASH_SECRET");
		expect(secret.status).toBe("fail");
		expect(secret.fix).toMatch(/^Fix:/);
		expect(secret.fix).toContain("BLOK_FLASH_SECRET");
	}, 60_000);

	it("only asks for BLOK_SESSION_SECRET when @blokjs/session is installed", async () => {
		const withSession = await inertiaDoctor({ cwd: HEALTHY, env: healthyEnv({ BLOK_SESSION_SECRET: undefined }) });
		expect(find(withSession, "BLOK_SESSION_SECRET").status).toBe("fail");
		expect(find(withSession, "BLOK_SESSION_SECRET").fix).toContain("BLOK_SESSION_SECRET");

		// The broken fixture does not depend on @blokjs/session.
		const without = await inertiaDoctor({
			cwd: BROKEN,
			env: healthyEnv({ BLOK_STATIC_DIR: join(BROKEN, "client-build") }),
		});
		expect(find(without, "BLOK_SESSION_SECRET").status).toBe("skip");
	}, 60_000);

	it("fails when SSR is configured but not answering", async () => {
		const checks = await inertiaDoctor({
			cwd: HEALTHY,
			env: healthyEnv({ BLOK_SSR_URL: "http://127.0.0.1:1" }),
		});
		const ssr = find(checks, "SSR");
		expect(ssr.status).toBe("fail");
		expect(ssr.fix).toContain("blokctl inertia start-ssr");
	}, 60_000);

	it("warns when a dev descriptor points at a dead port", async () => {
		const staticDir = mkdtempSync(join(tmpdir(), "blok-inertia-doctor-"));
		try {
			writeFileSync(
				join(staticDir, ".blok-vite.json"),
				JSON.stringify({ mode: "dev", devUrl: "http://127.0.0.1:1", entry: "src/main.tsx" }),
			);
			const checks = await inertiaDoctor({
				cwd: HEALTHY,
				env: healthyEnv({ BLOK_STATIC_DIR: staticDir }),
			});
			const descriptor = find(checks, ".blok-vite.json");
			expect(descriptor.status).toBe("warn");
			expect(descriptor.detail).toContain("nothing is listening");
			expect(descriptor.fix).toContain("blokInertia()");
		} finally {
			rmSync(staticDir, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("inertia doctor — the broken fixture", () => {
	it("catches the missing component, shell marker, CSRF middleware, asset version and Vite descriptor", async () => {
		const checks = await inertiaDoctor({
			cwd: BROKEN,
			env: healthyEnv({ BLOK_STATIC_DIR: join(BROKEN, "client-build") }),
		});

		const failures = checks.filter((check) => check.status === "fail");
		expect(failures.map((check) => check.name).sort()).toEqual([
			".blok-vite.json",
			"ASSET_VERSION",
			"ensurePagesExist",
			"inertia.csrf",
			"shell markers",
		]);
		// Every failure is actionable on its own.
		for (const failure of failures) expect(failure.fix, `${failure.name} has no Fix line`).toMatch(/^Fix:/);

		expect(find(checks, "ensurePagesExist").detail).toContain("Dashboard/Missing");
		expect(find(checks, "shell markers").fix).toContain("<!--blok:head-->");
		expect(find(checks, "inertia.csrf").fix).toContain("createCsrfMiddleware");
		expect(find(checks, ".blok-vite.json").fix).toContain("BLOK_STATIC_DIR=client/dist");
	}, 60_000);
});

describe("inertia doctor — exit status", () => {
	function runCli(cwd: string, env: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
		if (!existsSync(CLI_DIST)) throw new Error(`${CLI_DIST} not built — run bun run build first.`);
		return spawnSync("bun", [CLI_DIST, "inertia", "doctor"], {
			cwd,
			env: { ...env, PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NO_NANOCTL_TELEMETRY: "1" },
			encoding: "utf8",
			timeout: 120_000,
		});
	}

	it("exits 0 when everything is set", () => {
		const result = runCli(HEALTHY, healthyEnv());
		expect(`${result.stdout ?? ""}${result.stderr ?? ""}`).toContain("check(s) passed");
		expect(result.status).toBe(0);
	}, 120_000);

	it("exits non-zero with a Fix: line when BLOK_FLASH_SECRET is missing", () => {
		const result = runCli(HEALTHY, healthyEnv({ BLOK_FLASH_SECRET: undefined }));
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		expect(result.status).not.toBe(0);
		expect(output).toContain("Fix: set BLOK_FLASH_SECRET");
	}, 120_000);
});
