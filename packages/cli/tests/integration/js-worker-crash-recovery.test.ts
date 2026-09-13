/**
 * ADR 0016 §3 crash recovery, proven against the REAL worker binary.
 *
 * The policy unit tests live in `tests/services/supervisor.test.ts`; this is
 * the end-to-end half the conformance table needs: SIGKILL the persistent
 * JavaScript worker mid-session, and the very next `runtime.nodejs` step must
 * succeed because the supervisor brought a fresh process back on the same port.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GrpcRuntimeAdapter } from "@blokjs/runner";
import { afterAll, describe, expect, it } from "vitest";
import { waitForGrpcPort } from "../../src/services/health-probe.js";
import { type SupervisorHandle, superviseProcess } from "../../src/services/supervisor.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const WORKER_ENTRY = path.join(REPO_ROOT, "packages/js-runtime-worker/dist/bin.js");

async function claimPort(): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => resolve(port));
		});
	});
}

const children: ChildProcess[] = [];
let supervisor: SupervisorHandle | null = null;

afterAll(async () => {
	supervisor?.release();
	await Promise.all(
		children.map(
			(child) =>
				new Promise<void>((resolve) => {
					if (child.exitCode !== null || child.signalCode !== null) return resolve();
					child.once("exit", () => resolve());
					try {
						child.kill("SIGKILL");
					} catch {
						resolve();
					}
					setTimeout(resolve, 5_000);
				}),
		),
	);
});

describe.skipIf(!existsSync(WORKER_ENTRY))("supervised JavaScript worker survives a crash", () => {
	it("restarts the killed worker and serves the next step", async () => {
		const port = await claimPort();
		supervisor = superviseProcess({
			name: `Node.js Worker (grpc port ${port})`,
			policy: { maxRestarts: 3, windowMs: 60_000, baseDelayMs: 50, maxDelayMs: 200 },
			log: () => undefined,
			spawn: () => {
				const child = spawn(process.execPath, [WORKER_ENTRY], {
					cwd: path.join(REPO_ROOT, "packages/js-runtime-worker"),
					env: { ...process.env, GRPC_PORT: String(port), HOST: "127.0.0.1" },
					stdio: "ignore",
				});
				children.push(child);
				return child;
			},
		});

		const adapter = new GrpcRuntimeAdapter({
			kind: "nodejs" as never,
			host: "127.0.0.1",
			port,
			defaultDeadlineMs: 30_000,
			maxMessageBytes: 16 * 1024 * 1024,
			keepalive: { timeMs: 10_000, timeoutMs: 5_000, permitWithoutCalls: true },
			healthCheckIntervalMs: 0,
		});
		const execute = async (): Promise<{ success?: boolean; data?: Record<string, unknown> | null }> =>
			(await adapter.execute(
				{ node: "typed-greet", name: "s1", type: "runtime.nodejs" } as never,
				{
					id: "crash-recovery",
					request: { body: {}, headers: {}, params: {}, query: {}, method: "POST", url: "/", cookies: {}, baseUrl: "" },
					response: { data: null, contentType: "application/json", success: true, error: null },
					state: {},
					vars: {},
					env: {},
					config: { s1: { inputs: { name: "Ada", repeat: 1 } } },
				} as never,
			)) as never;

		expect(await waitForGrpcPort(port, 40_000)).toBe(true);
		const before = await execute();
		expect(before.success).toBe(true);
		const firstPid = supervisor.child.pid;

		// The crash. SIGKILL, so nothing drains and nothing shuts down cleanly —
		// exactly the case `blokctl dev` could not recover from before.
		supervisor.child.kill("SIGKILL");

		const deadline = Date.now() + 40_000;
		while (Date.now() < deadline && (supervisor.restarts === 0 || supervisor.child.pid === firstPid)) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(supervisor.restarts).toBe(1);
		expect(supervisor.child.pid).not.toBe(firstPid);
		expect(await waitForGrpcPort(port, 40_000)).toBe(true);

		// The assertion that matters: the NEXT step works, over the same adapter
		// (the gRPC channel reconnects to the replacement process).
		const after = await execute();
		expect(after.success).toBe(true);
		expect(after.data).toMatchObject({ greeting: "Hello, Ada" });
	}, 120_000);
});
