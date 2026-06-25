import { type AddressInfo, type Server, createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
