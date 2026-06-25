import { type AddressInfo, type Server, createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryRunStore } from "../../../src/tracing/InMemoryRunStore";
import { RunTracker } from "../../../src/tracing/RunTracker";

/**
 * OBS-05 T4 — terminal-failure webhooks. The `fireWebhooks` eventMap was
 * extended to cover crashed/timedOut/throttled/cancelled. These tests spin
 * up a real local HTTP server (no nock — the tracker uses node:http
 * directly) + assert the push fires with the right event name.
 */
describe("RunTracker — terminal-failure webhooks (OBS-05 T4)", () => {
	let server: Server;
	let baseUrl: string;
	let received: Array<{ event: string; run: { status?: string } | null }>;

	beforeEach(async () => {
		RunTracker.resetInstance();
		received = [];
		server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c as Buffer));
			req.on("end", () => {
				try {
					received.push(JSON.parse(Buffer.concat(chunks).toString()));
				} catch {
					// ignore non-JSON
				}
				res.statusCode = 200;
				res.end();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		baseUrl = `http://127.0.0.1:${port}`;
	});

	afterEach(async () => {
		RunTracker.resetInstance();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	function startBaseRun(workflowName = "wf"): string {
		return RunTracker.getInstance().startRun({
			workflowName,
			workflowPath: "/p",
			triggerType: "http",
			triggerSummary: "POST /test",
			nodeCount: 1,
		}).id;
	}

	/** Poll the captured POSTs for a given event (fire-and-forget delivery). */
	async function waitForEvent(event: string, timeoutMs = 2000): Promise<{ run: { status?: string } | null }> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const hit = received.find((r) => r.event === event);
			if (hit) return hit;
			await new Promise((r) => setTimeout(r, 10));
		}
		throw new Error(`webhook event "${event}" not received within ${timeoutMs}ms`);
	}

	it("fires a run.crashed webhook on markRunCrashed", async () => {
		const tracker = RunTracker.getInstance();
		tracker.registerWebhook({ url: baseUrl, events: ["run.crashed"] });
		const runId = startBaseRun();

		tracker.markRunCrashed(runId, { error: new Error("OOM") });

		const hit = await waitForEvent("run.crashed");
		expect(hit.event).toBe("run.crashed");
		expect(hit.run?.status).toBe("crashed");
	});

	it("does NOT fire run.crashed to a webhook only subscribed to run.completed", async () => {
		const tracker = RunTracker.getInstance();
		tracker.registerWebhook({ url: baseUrl, events: ["run.completed"] });
		const runId = startBaseRun();

		tracker.markRunCrashed(runId, { error: new Error("boom") });

		// Give the fire-and-forget path a chance to (incorrectly) deliver.
		await new Promise((r) => setTimeout(r, 100));
		expect(received.some((r) => r.event === "run.crashed")).toBe(false);
	});
});

/**
 * OBS-05 T7 — durable webhook persistence. A webhook persisted to the store
 * (e.g. registered before a process restart) must be seeded into a fresh
 * RunTracker's in-memory hot Map on first access, AND fire on the first
 * matching event after boot.
 */
describe("RunTracker — durable webhook persistence (OBS-05 T7)", () => {
	let server: Server;
	let baseUrl: string;
	let received: Array<{ event: string }>;

	beforeEach(async () => {
		received = [];
		server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c) => chunks.push(c as Buffer));
			req.on("end", () => {
				try {
					received.push(JSON.parse(Buffer.concat(chunks).toString()));
				} catch {
					// ignore
				}
				res.statusCode = 200;
				res.end();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("register persists to the store, and a fresh tracker seeds it from the store", () => {
		// First tracker registers + persists.
		const store = new InMemoryRunStore();
		const t1 = new RunTracker(undefined, store);
		const wh = t1.registerWebhook({ url: baseUrl, events: ["run.completed"], secret: "abc" });
		expect(store.getWebhooks().map((w) => w.id)).toContain(wh.id);

		// A fresh tracker over the SAME store sees the webhook (recovery).
		const t2 = new RunTracker(undefined, store);
		const seeded = t2.getWebhooks();
		expect(seeded).toHaveLength(1);
		expect(seeded[0]).toMatchObject({ id: wh.id, url: baseUrl, events: ["run.completed"], active: true });
	});

	it("removeWebhook deletes from the store too", () => {
		const store = new InMemoryRunStore();
		const t1 = new RunTracker(undefined, store);
		const wh = t1.registerWebhook({ url: baseUrl, events: ["run.failed"] });
		expect(t1.removeWebhook(wh.id)).toBe(true);
		expect(store.getWebhooks()).toEqual([]);
	});

	it("a seeded webhook fires on the first matching event after a restart", async () => {
		const store = new InMemoryRunStore();
		// Simulate a registration that survived a restart by writing directly
		// to the store, then booting a fresh tracker over it.
		store.saveWebhook({
			id: "wh_seeded",
			url: baseUrl,
			events: ["run.completed"],
			secret: undefined,
			createdAt: Date.now(),
			active: true,
			failCount: 0,
		});

		const tracker = new RunTracker(undefined, store);
		const run = tracker.startRun({
			workflowName: "wf",
			workflowPath: "/p",
			triggerType: "http",
			triggerSummary: "POST /test",
			nodeCount: 1,
		});
		tracker.completeRun(run.id);

		const deadline = Date.now() + 2000;
		while (Date.now() < deadline && !received.some((r) => r.event === "run.completed")) {
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(received.some((r) => r.event === "run.completed")).toBe(true);
	});
});
