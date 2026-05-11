/**
 * v0.7 PR 4 — full end-to-end webhook trigger integration test.
 *
 * Spins up a real Hono app + `@hono/node-server` with a real
 * WebhookTrigger configured for a GitHub-style provider. Sends a
 * signed POST via native `fetch` and asserts the workflow ran. A
 * second POST with the same delivery id exercises the replay-cache
 * dedup path and expects `{ status: "duplicate" }`.
 *
 * Complements `WebhookTrigger.test.ts` + `verifiers.test.ts` (unit
 * coverage of the public surface).
 */

import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { NodeMap, RunTracker, WorkflowRegistry, defineNode } from "@blokjs/runner";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@opentelemetry/api", () => ({
	trace: {
		getTracer: () => ({
			startActiveSpan: (_name: string, fn: (span: unknown) => unknown) =>
				fn({ setAttribute: vi.fn(), setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() }),
		}),
	},
	metrics: {
		getMeter: () => ({
			createCounter: () => ({ add: vi.fn() }),
			createHistogram: () => ({ record: vi.fn() }),
			createGauge: () => ({ record: vi.fn() }),
			createObservableGauge: () => ({ addCallback: vi.fn() }),
		}),
	},
	SpanStatusCode: { OK: 0, ERROR: 1 },
}));

import WebhookTriggerClass, { _setActiveWebhookTrigger } from "./WebhookTrigger";

const TEST_PORT = 4903;
const SECRET = "shhh-its-a-secret-1234567890";

function hmacHex(body: string): string {
	return createHmac("sha256", SECRET).update(body).digest("hex");
}

const handleNode = defineNode({
	name: "handle-event",
	description: "test fixture — record the event id + type",
	input: z.object({}).passthrough(),
	output: z.object({ handled: z.boolean(), eventId: z.string() }),
	async execute(ctx) {
		const body = (ctx.request?.body as { delivery_id?: string } | undefined) ?? {};
		return { handled: true, eventId: body.delivery_id ?? "" };
	},
});

describe("WebhookTrigger — v0.7 PR 4 integration (real HTTP)", () => {
	let app: Hono;
	let trigger: InstanceType<typeof WebhookTriggerClass>;
	let httpServer: Server | null = null;

	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		_setActiveWebhookTrigger(null);
		process.env.GH_SECRET = SECRET;
		app = new Hono();
	});

	afterEach(
		() =>
			new Promise<void>((resolve) => {
				if (trigger) void trigger.stop();
				if (httpServer) {
					httpServer.close(() => {
						httpServer = null;
						WorkflowRegistry.resetInstance();
						_setActiveWebhookTrigger(null);
						process.env.GH_SECRET = undefined;
						resolve();
					});
				} else {
					WorkflowRegistry.resetInstance();
					_setActiveWebhookTrigger(null);
					process.env.GH_SECRET = undefined;
					resolve();
				}
			}),
	);

	it("verifies a signed GitHub-style POST, runs the workflow, and dedups replays", async () => {
		const nodes = new NodeMap();
		nodes.addNode("handle-event", handleNode);

		WorkflowRegistry.getInstance().register({
			name: "gh-events",
			source: "/test/gh.json",
			workflow: {
				name: "gh-events",
				version: "1.0.0",
				trigger: {
					webhook: {
						provider: "github",
						path: "/webhooks/github",
						secretEnv: "GH_SECRET",
						idempotencyKey: "js/ctx.request.headers['x-github-delivery']",
					},
				},
				steps: [{ id: "handle", node: "handle-event", type: "module", inputs: {} }],
				nodes: { handle: { inputs: {} } },
			},
		});

		trigger = new WebhookTriggerClass(app);
		trigger.setNodeMap({ nodes });
		await trigger.listen();

		await new Promise<void>((resolve) => {
			httpServer = serve({ fetch: app.fetch, port: TEST_PORT }, () => resolve()) as Server;
		});

		const body = JSON.stringify({ ref: "refs/heads/main", delivery_id: "delivery-uuid-9" });
		const sig = `sha256=${hmacHex(body)}`;
		const reqInit = {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-hub-signature-256": sig,
				"x-github-event": "push",
				"x-github-delivery": "delivery-uuid-9",
			},
			body,
		};

		// First delivery — should run the workflow.
		const first = await fetch(`http://localhost:${TEST_PORT}/webhooks/github`, reqInit);
		expect(first.status).toBe(200);
		const firstJson = (await first.json()) as { status?: string; eventId?: string };
		expect(firstJson.status).toBe("ok");
		expect(firstJson.eventId).toBe("delivery-uuid-9");

		// Second delivery with the same delivery id — replay cache should
		// short-circuit with `duplicate` and NOT run the workflow.
		const second = await fetch(`http://localhost:${TEST_PORT}/webhooks/github`, reqInit);
		expect(second.status).toBe(200);
		const secondJson = (await second.json()) as { status?: string; eventId?: string };
		expect(secondJson.status).toBe("duplicate");
		expect(secondJson.eventId).toBe("delivery-uuid-9");
	}, 15_000);
});

// Drain the per-process RunTracker after the suite to keep singletons
// from leaking into other tests in the same project.
afterEach(() => {
	try {
		RunTracker.resetInstance();
	} catch {
		/* ignore — older test orderings */
	}
});
