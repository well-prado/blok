/**
 * Backpressure over the real wire.
 *
 * The concurrency gate is unit-tested directly, but the thing that matters to a
 * runner is what comes BACK when the worker is saturated: a decodable
 * `NodeError` it can retry, not a dropped call or an unbounded wait. This boots
 * the server in-process (no `dist` needed) with a one-slot, zero-queue gate and
 * drives it with the runner's own adapter.
 */

import { GrpcRuntimeAdapter } from "@blokjs/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { builtinNodes } from "../src/builtins.js";
import { WorkerRegistry } from "../src/registry.js";
import { type WorkerHandle, startWorkerServer } from "../src/server.js";

let worker: WorkerHandle;
let adapter: GrpcRuntimeAdapter;

beforeAll(async () => {
	const registry = new WorkerRegistry();
	for (const node of builtinNodes(() => registry.executions)) registry.register(node);
	worker = await startWorkerServer({ registry, port: 0, maxConcurrency: 1, maxQueue: 0 });
	adapter = new GrpcRuntimeAdapter({
		kind: "nodejs",
		host: "127.0.0.1",
		port: worker.port,
		defaultDeadlineMs: 30_000,
		maxMessageBytes: 16 * 1024 * 1024,
		keepalive: { timeMs: 10_000, timeoutMs: 5_000, permitWithoutCalls: true },
		healthCheckIntervalMs: 0,
	});
});

afterAll(async () => {
	await worker?.shutdown();
});

function ctxWith(inputs: unknown): unknown {
	return {
		id: "overload",
		request: { body: {}, headers: {}, params: {}, query: {}, method: "POST", url: "/", cookies: {}, baseUrl: "" },
		response: { data: null, contentType: "application/json", success: true, error: null },
		state: {},
		vars: {},
		env: {},
		config: { s1: { inputs } },
	};
}

function run(node: string, inputs: unknown): Promise<{ success: boolean; errors: unknown }> {
	return adapter.execute({ node, name: "s1", type: "runtime.nodejs" } as never, ctxWith(inputs) as never) as never;
}

describe("worker backpressure", () => {
	it("rejects past the concurrency + queue limit with a retryable WORKER_OVERLOADED", async () => {
		// One slot, no queue: the first call occupies the worker, the rest are
		// refused rather than piling up behind it.
		const results = await Promise.all([
			run("slow-echo", { ms: 400, value: "a" }),
			run("slow-echo", { ms: 400, value: "b" }),
			run("slow-echo", { ms: 400, value: "c" }),
		]);

		const overloaded = results.filter((r) => JSON.stringify(r.errors ?? null).includes("WORKER_OVERLOADED"));
		expect(overloaded.length).toBeGreaterThanOrEqual(1);
		expect(results.some((r) => r.success === true)).toBe(true);

		const envelope = JSON.parse(JSON.stringify(overloaded[0].errors));
		expect(envelope).toMatchObject({ category: "RATE_LIMIT", httpStatus: 503, retryable: true });
		expect(String(envelope.remediation)).toContain("BLOK_WORKER_MAX_CONCURRENCY");
	});

	it("keeps serving once the pressure clears", async () => {
		const after = await run("worker-info", {});
		expect(after.success).toBe(true);
	});
});
