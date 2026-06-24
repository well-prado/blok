/**
 * WebhookTrigger — v0.7 PR 4 — unit tests for the public surface.
 *
 * Covers construction, the pre-catch-all hook coordination contract
 * with HttpTrigger, route discovery via WorkflowRegistry, idempotent
 * listen(), and the singleton helper accessor. End-to-end coverage
 * (real HTTP POST with a signed Stripe-shaped payload + replay
 * dedup) lives in `WebhookTrigger.integration.test.ts`.
 */

import { createHmac } from "node:crypto";
import { WorkflowRegistry } from "@blokjs/runner";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@opentelemetry/api", () => {
	const noop = { setAttribute: () => {}, setStatus: () => {}, recordException: () => {}, end: () => {} };
	return {
		trace: {
			getTracer: () => ({
				startActiveSpan: (...a: unknown[]) => {
					const fn = a.find((x) => typeof x === "function") as ((s: typeof noop) => unknown) | undefined;
					return fn?.(noop);
				},
				startSpan: () => noop,
			}),
			getActiveSpan: () => undefined,
			setSpan: (c: unknown) => c,
		},
		metrics: {
			getMeter: () => ({
				createCounter: () => ({ add: () => {} }),
				createHistogram: () => ({ record: () => {} }),
				createGauge: () => ({ record: () => {} }),
				createObservableGauge: () => ({ addCallback: () => {} }),
			}),
		},
		context: { active: () => ({}), with: (_c: unknown, fn: () => unknown) => fn() },
		propagation: { extract: (c: unknown) => c, inject: () => {} },
		SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 },
		SpanStatusCode: { OK: 0, ERROR: 1 },
		isSpanContextValid: () => false,
	};
});

import WebhookTrigger, { _getActiveWebhookTrigger, _setActiveWebhookTrigger } from "./WebhookTrigger";

const SECRET = "shhh-its-a-secret-1234567890";

function hmacHex(data: string, secret = SECRET): string {
	return createHmac("sha256", secret).update(data).digest("hex");
}

describe("WebhookTrigger — v0.7 PR 4", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		_setActiveWebhookTrigger(null);
		process.env.GH_SECRET = SECRET;
	});

	afterEach(() => {
		_setActiveWebhookTrigger(null);
		process.env.GH_SECRET = undefined;
	});

	describe("constructor()", () => {
		it("registers as the active webhook trigger singleton", () => {
			const app = new Hono();
			const trigger = new WebhookTrigger(app);
			expect(trigger).toBeDefined();
			expect(_getActiveWebhookTrigger()).toBe(trigger);
		});

		it("accepts an optional httpTrigger for pre-catch-all coordination", () => {
			const app = new Hono();
			const addPreCatchAllHook = vi.fn();
			const httpTrigger = { addPreCatchAllHook };
			const trigger = new WebhookTrigger(app, httpTrigger);
			expect(trigger).toBeDefined();
			expect(addPreCatchAllHook).not.toHaveBeenCalled();
		});
	});

	describe("listen()", () => {
		it("registers a POST route per webhook workflow in the registry", async () => {
			const app = new Hono();
			WorkflowRegistry.getInstance().register({
				name: "gh-events",
				source: "/test/gh.json",
				workflow: {
					name: "gh-events",
					version: "1.0.0",
					trigger: { webhook: { provider: "github", path: "/webhooks/github", secretEnv: "GH_SECRET" } },
					steps: [],
				},
			});

			const trigger = new WebhookTrigger(app);
			await trigger.listen();

			// Send a valid signed POST — should at least not 404.
			const body = JSON.stringify({ ref: "refs/heads/main" });
			const res = await app.fetch(
				new Request("http://localhost/webhooks/github", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-hub-signature-256": `sha256=${hmacHex(body)}`,
						"x-github-event": "push",
						"x-github-delivery": "delivery-1",
					},
					body,
				}),
			);
			expect(res.status).not.toBe(404);
		});

		it("skips workflows without trigger.webhook config", async () => {
			const app = new Hono();
			WorkflowRegistry.getInstance().register({
				name: "http-only",
				source: "/test/http.json",
				workflow: {
					name: "http-only",
					version: "1.0.0",
					trigger: { http: { method: "POST", path: "/api/foo" } },
					steps: [],
				},
			});
			const trigger = new WebhookTrigger(app);
			await trigger.listen();
			// No webhook route mounted — anything not on app returns 404.
			const res = await app.fetch(new Request("http://localhost/webhooks/anywhere", { method: "POST" }));
			expect(res.status).toBe(404);
		});

		it("skips workflows with neither `provider` nor `signature`", async () => {
			const app = new Hono();
			WorkflowRegistry.getInstance().register({
				name: "misconfigured",
				source: "/test/bad.json",
				workflow: {
					name: "misconfigured",
					version: "1.0.0",
					trigger: { webhook: { path: "/webhooks/bad" } },
					steps: [],
				},
			});
			const trigger = new WebhookTrigger(app);
			await trigger.listen();
			expect(trigger.getStats().workflowsRegistered).toBe(0);
		});

		it("registers a pre-catch-all hook on httpTrigger when provided", async () => {
			const app = new Hono();
			const addPreCatchAllHook = vi.fn();
			const httpTrigger = { addPreCatchAllHook };
			WorkflowRegistry.getInstance().register({
				name: "gh-events",
				source: "/test/gh.json",
				workflow: {
					name: "gh-events",
					version: "1.0.0",
					trigger: { webhook: { provider: "github", path: "/webhooks/github", secretEnv: "GH_SECRET" } },
					steps: [],
				},
			});
			const trigger = new WebhookTrigger(app, httpTrigger);
			await trigger.listen();
			expect(addPreCatchAllHook).toHaveBeenCalledTimes(1);
			expect(addPreCatchAllHook).toHaveBeenCalledWith(expect.any(Function));
		});

		it("is idempotent — second listen() call is a no-op", async () => {
			const app = new Hono();
			const trigger = new WebhookTrigger(app);
			await trigger.listen();
			await expect(trigger.listen()).resolves.toBeTypeOf("number");
		});
	});

	describe("request handling", () => {
		it("returns 401 with structured reason when the signature is invalid", async () => {
			const app = new Hono();
			WorkflowRegistry.getInstance().register({
				name: "gh-events",
				source: "/test/gh.json",
				workflow: {
					name: "gh-events",
					version: "1.0.0",
					trigger: { webhook: { provider: "github", path: "/webhooks/github", secretEnv: "GH_SECRET" } },
					steps: [],
				},
			});
			const trigger = new WebhookTrigger(app);
			await trigger.listen();

			const res = await app.fetch(
				new Request("http://localhost/webhooks/github", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-hub-signature-256": "sha256=deadbeef",
						"x-github-event": "push",
					},
					body: JSON.stringify({}),
				}),
			);
			expect(res.status).toBe(401);
			const json = (await res.json()) as { reason?: string };
			expect(json.reason).toBe("signature_mismatch");
		});

		it("returns 200 `ignored` when the event isn't in the allowlist", async () => {
			const app = new Hono();
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
							events: ["push"],
						},
					},
					steps: [],
				},
			});
			const trigger = new WebhookTrigger(app);
			await trigger.listen();

			const body = JSON.stringify({});
			const res = await app.fetch(
				new Request("http://localhost/webhooks/github", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-hub-signature-256": `sha256=${hmacHex(body)}`,
						"x-github-event": "pull_request",
					},
					body,
				}),
			);
			expect(res.status).toBe(200);
			const json = (await res.json()) as { status?: string; reason?: string };
			expect(json.status).toBe("ignored");
			expect(json.reason).toBe("event_not_allowed");
		});
	});

	describe("stop()", () => {
		it("clears the singleton", async () => {
			const app = new Hono();
			const trigger = new WebhookTrigger(app);
			await trigger.listen();
			await trigger.stop();
			expect(_getActiveWebhookTrigger()).toBeNull();
		});
	});
});
