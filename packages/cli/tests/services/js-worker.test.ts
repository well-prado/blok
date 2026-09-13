import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostTargetFromStartCommands, jsWorkerPort, planJsWorker } from "../../src/services/js-worker.js";
import {
	JS_WORKER_ENTRY,
	detectJavaScriptRuntime,
	parseJavaScriptVersion,
} from "../../src/services/runtime-detector.js";

async function projectWithWorker(installed: boolean): Promise<string> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "blok-jsworker-"));
	if (installed) {
		const entry = path.join(dir, JS_WORKER_ENTRY);
		fs.mkdirSync(path.dirname(entry), { recursive: true });
		fs.writeFileSync(entry, "// stub\n");
	}
	return dir;
}

afterEach(() => vi.unstubAllEnvs());

describe("host target detection", () => {
	it("reads the engine out of the trigger start commands", () => {
		expect(hostTargetFromStartCommands(["bun run src/triggers/http/index.ts"])).toBe("bun");
		expect(hostTargetFromStartCommands(["node dist/index.js"])).toBe("node");
		expect(hostTargetFromStartCommands(["deno run -A src/index.ts"])).toBe("deno");
	});

	it("defaults to bun — what `blokctl dev` boots triggers with", () => {
		expect(hostTargetFromStartCommands([])).toBe("bun");
		expect(hostTargetFromStartCommands(["npx something"])).toBe("bun");
	});
});

describe("worker port resolution", () => {
	it("prefers the per-kind override over the canonical default", () => {
		expect(jsWorkerPort("node", 10012, {})).toBe(10012);
		expect(jsWorkerPort("node", 10012, { RUNTIME_NODEJS_GRPC_PORT: "21012" })).toBe(21012);
		expect(jsWorkerPort("deno", 10014, { RUNTIME_DENO_GRPC_PORT: "not-a-port" })).toBe(10014);
	});
});

describe("version parsing", () => {
	it("reads each engine's own --version format", () => {
		expect(parseJavaScriptVersion("v22.11.0", "node")).toBe("22.11.0");
		expect(parseJavaScriptVersion("1.1.38", "bun")).toBe("1.1.38");
		expect(parseJavaScriptVersion("deno 2.1.4 (stable, release, aarch64-apple-darwin)", "deno")).toBe("2.1.4");
	});
});

describe("planJsWorker", () => {
	it("runs in-process when the host IS the selected target", async () => {
		const dir = await projectWithWorker(true);
		const plan = await planJsWorker({ projectRoot: dir, target: "bun", hostTarget: "bun" });
		expect(plan.kind).toBe("in-process");
	});

	it("skips with remediation when the worker package is missing", async () => {
		const dir = await projectWithWorker(false);
		const plan = await planJsWorker({ projectRoot: dir, target: "node", hostTarget: "bun" });
		expect(plan).toMatchObject({ kind: "skip" });
		expect((plan as { reason: string }).reason).toContain("@blokjs/runtime-worker is not installed");
	});

	it("honours the explicit opt-out", async () => {
		vi.stubEnv("BLOK_SKIP_JS_WORKER", "1");
		const dir = await projectWithWorker(true);
		const plan = await planJsWorker({ projectRoot: dir, target: "deno", hostTarget: "bun" });
		expect(plan).toMatchObject({ kind: "skip", reason: "BLOK_SKIP_JS_WORKER=1" });
	});

	it("plans a Node.js worker spawn on the canonical port", async () => {
		const node = await detectJavaScriptRuntime("node");
		if (!node.available) return; // no Node on this machine; nothing to assert
		const dir = await projectWithWorker(true);
		const plan = await planJsWorker({ projectRoot: dir, target: "node", hostTarget: "bun" });
		expect(plan.kind).toBe("spawn");
		const spawn = (plan as { spawn: { cmd: string; args: string[]; port: number; env: Record<string, string> } }).spawn;
		expect(spawn.cmd).toBe("node");
		expect(spawn.port).toBe(10012);
		expect(spawn.env.GRPC_PORT).toBe("10012");
		expect(spawn.args[0]).toContain(JS_WORKER_ENTRY);
	});

	it("never substitutes another engine for an unavailable one", async () => {
		const dir = await projectWithWorker(true);
		const plan = await planJsWorker({ projectRoot: dir, target: "deno", hostTarget: "bun" });
		// Either Deno is present and we plan a deno spawn, or it is absent and we
		// skip with remediation. There is no third outcome that runs the step.
		if (plan.kind === "spawn") expect(plan.spawn.cmd).toBe("deno");
		else expect(plan).toMatchObject({ kind: "skip" });
	});
});
