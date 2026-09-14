import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { build } from "vite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { checkSsr, startSsr, stopSsr } from "../../../src/commands/inertia/ssr.js";

const CLI_DIST = resolve(__dirname, "../../../dist/index.js");
const FIXTURE = resolve(__dirname, "../../fixtures/inertia-ssr");
const REPO_ROOT = resolve(__dirname, "../../../../..");
let output = "";
let bundle = "";
let running: Promise<void> | undefined;

async function randomPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("port probe did not bind");
	await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
	return address.port;
}

async function waitUntilHealthy(): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!(await checkSsr())) {
		if (Date.now() > deadline) throw new Error("SSR fixture did not become healthy");
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	}
}

function runCli(args: string[]): ReturnType<typeof spawnSync> {
	if (!existsSync(CLI_DIST)) throw new Error(`${CLI_DIST} not built — run bun run build first.`);
	return spawnSync("bun", [CLI_DIST, ...args], {
		env: { ...process.env, PATH: `${output}:${process.env.PATH ?? ""}`, NO_NANOCTL_TELEMETRY: "1" },
		encoding: "utf8",
		timeout: 30_000,
	});
}

beforeAll(async () => {
	output = mkdtempSync(join(resolve(__dirname, "../../.."), ".ssr-test-"));
	await build({
		root: FIXTURE,
		logLevel: "silent",
		resolve: { alias: [{ find: /^react$/, replacement: join(REPO_ROOT, "node_modules/react/index.js") }] },
		build: {
			ssr: "ssr.ts",
			outDir: output,
			emptyOutDir: true,
			rollupOptions: { output: { entryFileNames: "ssr.mjs" } },
		},
	});
	const npm = join(output, "npm");
	writeFileSync(npm, "#!/bin/sh\necho 2.3.0\n");
	chmodSync(npm, 0o755);
	bundle = join(output, "ssr.mjs");
});

afterAll(() => {
	rmSync(output, { recursive: true, force: true });
});

beforeEach(() => {
	vi.unstubAllEnvs();
});

afterEach(async () => {
	if (await checkSsr()) await stopSsr();
	await running?.catch(() => undefined);
	running = undefined;
});

describe("#1001 SSR CLI", () => {
	it("9 — start, check, and stop have health-check exit semantics", async () => {
		const port = await randomPort();
		vi.stubEnv("BLOK_SSR_URL", `http://127.0.0.1:${port}`);
		running = startSsr({ runtime: "node", port, bundle });
		await waitUntilHealthy();

		const healthy = runCli(["inertia", "check-ssr"]);
		expect(healthy.status).toBe(0);
		expect(healthy.stdout).toContain("OK");

		const stopped = runCli(["inertia", "stop-ssr"]);
		expect(stopped.status).toBe(0);
		await running;
		running = undefined;

		const unhealthy = runCli(["inertia", "check-ssr"]);
		expect(unhealthy.status).toBe(1);
		expect(unhealthy.stderr).toContain("not running");
	});

	it("10 — --runtime bun launches the bundle with the Bun binary", async () => {
		const port = await randomPort();
		const argvFile = join(output, "bun-argv.json");
		vi.stubEnv("BLOK_SSR_URL", `http://127.0.0.1:${port}`);
		vi.stubEnv("SSR_ARGV_FILE", argvFile);
		running = startSsr({ runtime: "bun", port, bundle });
		await waitUntilHealthy();

		const argv = JSON.parse(readFileSync(argvFile, "utf8")) as { execPath: string; argv: string[] };
		expect(basename(argv.execPath)).toContain("bun");
		expect(argv.argv.some((value) => value.endsWith("/ssr.mjs"))).toBe(true);

		await stopSsr();
		await running;
		running = undefined;
	});

	it("11 — a real Vite-built SSR entry renders the fixture Home component", async () => {
		const port = await randomPort();
		vi.stubEnv("BLOK_SSR_URL", `http://127.0.0.1:${port}`);
		running = startSsr({ runtime: "node", port, bundle });
		await waitUntilHealthy();

		const response = await fetch(`http://127.0.0.1:${port}/render`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ component: "Home", props: {}, url: "/", version: "test" }),
		});
		const rendered = (await response.json()) as { body: string };
		expect(rendered.body).toContain("Home from the Vite SSR fixture");

		await stopSsr();
		await running;
		running = undefined;
	});
});
