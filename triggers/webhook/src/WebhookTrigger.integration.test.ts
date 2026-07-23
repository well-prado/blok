/**
 * v0.7 PR 4 — full end-to-end webhook trigger integration test.
 *
 * Spins up a real Hono app + `@hono/node-server` with a real
 * WebhookTrigger configured for a GitHub-style provider. Sends signed
 * POSTs via native `fetch` — signatures are computed with the real
 * `node:crypto` HMAC, and requests cross the real wire into the real
 * trigger + verifier + workflow runner. Nothing about verify/dispatch
 * is mocked (only OTel is stubbed, to avoid an exporter).
 *
 * The fixture node records each execution into a module-level array
 * (`EXECUTIONS`) so the tests assert an OBSERVABLE side effect of the
 * workflow actually running — not just a 200 status. This is what
 * distinguishes "the signature was accepted" from "the response looked
 * fine but nothing ran".
 *
 * HMAC matrix (each proves the verify logic, not just the HTTP path):
 *   1. VALID   signature -> 200 + the workflow executed exactly once.
 *   2. TAMPERED body (valid-looking sig over DIFFERENT bytes) -> 401
 *      + the workflow did NOT execute.
 *   3. MISSING signature header -> 401 + the workflow did NOT execute.
 * Plus the replay-cache dedup path (same delivery id -> duplicate,
 * second run does not execute).
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

import WebhookTriggerClass, { _setActiveWebhookTrigger } from "./WebhookTrigger";

const TEST_PORT = 4903;
const SECRET = "shhh-its-a-secret-1234567890";
// Namespace the mount path + env var per run so a concurrent target on
// the same box never collides on the route or the process env slot.
const SUFFIX = Math.random().toString(36).slice(2);
const WEBHOOK_PATH = `/webhooks/github-${SUFFIX}`;
// ADR 0015 — a second workflow declaring a required-field `input` schema, to
// prove a signed-but-schema-invalid delivery returns a real 400 (not a 200).
const VALIDATED_PATH = `/webhooks/validated-${SUFFIX}`;
const SECRET_ENV = `GH_SECRET_${SUFFIX}`;

// Observable side effect of a real workflow run. The fixture node
// pushes here inside `execute`; tests assert on it to prove the node
// body actually ran (a mounted-but-not-dispatched path would leave it
// empty even while returning a healthy-looking 200).
const EXECUTIONS: Array<{ eventId: string }> = [];

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
		const eventId = body.delivery_id ?? "";
		EXECUTIONS.push({ eventId });
		return { handled: true, eventId };
	},
});

describe("WebhookTrigger — v0.7 PR 4 integration (real HTTP)", () => {
	let app: Hono;
	let trigger: InstanceType<typeof WebhookTriggerClass>;
	let httpServer: Server | null = null;

	beforeEach(async () => {
		EXECUTIONS.length = 0;
		WorkflowRegistry.resetInstance();
		_setActiveWebhookTrigger(null);
		process.env[SECRET_ENV] = SECRET;
		app = new Hono();

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
						path: WEBHOOK_PATH,
						secretEnv: SECRET_ENV,
						idempotencyKey: "js/ctx.request.headers['x-github-delivery']",
					},
				},
				steps: [{ id: "handle", node: "handle-event", type: "module", inputs: {} }],
				nodes: { handle: { inputs: {} } },
			},
		});

		WorkflowRegistry.getInstance().register({
			name: "gh-validated",
			source: "/test/gh-validated.json",
			workflow: {
				name: "gh-validated",
				version: "1.0.0",
				trigger: {
					webhook: {
						provider: "github",
						path: VALIDATED_PATH,
						secretEnv: SECRET_ENV,
						idempotencyKey: "js/ctx.request.headers['x-github-delivery']",
					},
				},
				input: z.object({ orderId: z.string() }), // required — a body without it 400s
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
						process.env[SECRET_ENV] = undefined;
						resolve();
					});
				} else {
					WorkflowRegistry.resetInstance();
					_setActiveWebhookTrigger(null);
					process.env[SECRET_ENV] = undefined;
					resolve();
				}
			}),
	);

	const url = () => `http://localhost:${TEST_PORT}${WEBHOOK_PATH}`;
	// Each test restarts a fresh server on the same TEST_PORT. `connection:
	// close` stops undici from pooling a socket onto the previous (now-closed)
	// server, which otherwise surfaces as a flaky ECONNRESET on the 2nd test.
	const baseHeaders = { "content-type": "application/json", connection: "close" };

	it("VALID HMAC — runs the workflow (observable effect) and dedups replays", async () => {
		const body = JSON.stringify({ ref: "refs/heads/main", delivery_id: "delivery-uuid-9" });
		const reqInit = {
			method: "POST",
			headers: {
				...baseHeaders,
				"x-hub-signature-256": `sha256=${hmacHex(body)}`,
				"x-github-event": "push",
				"x-github-delivery": "delivery-uuid-9",
			},
			body,
		};

		// First delivery — verified, runs the workflow.
		const first = await fetch(url(), reqInit);
		expect(first.status).toBe(200);
		const firstJson = (await first.json()) as { status?: string; eventId?: string };
		expect(firstJson.status).toBe("ok");
		expect(firstJson.eventId).toBe("delivery-uuid-9");
		// Observable proof the node body actually ran — exactly once.
		expect(EXECUTIONS).toEqual([{ eventId: "delivery-uuid-9" }]);

		// Second delivery, same delivery id — replay cache short-circuits
		// with `duplicate` and does NOT run the workflow again.
		const second = await fetch(url(), reqInit);
		expect(second.status).toBe(200);
		const secondJson = (await second.json()) as { status?: string; eventId?: string };
		expect(secondJson.status).toBe("duplicate");
		expect(secondJson.eventId).toBe("delivery-uuid-9");
		// Still exactly one execution — the replay did not dispatch.
		expect(EXECUTIONS).toEqual([{ eventId: "delivery-uuid-9" }]);
	}, 15_000);

	it("ADR 0015 — signed but schema-invalid body → 400 validation_errors, workflow NOT run, delivery NOT cached", async () => {
		const vUrl = `http://localhost:${TEST_PORT}${VALIDATED_PATH}`;
		const body = JSON.stringify({ notOrderId: "x" }); // missing required `orderId`
		const reqInit = {
			method: "POST",
			headers: {
				...baseHeaders,
				"x-hub-signature-256": `sha256=${hmacHex(body)}`, // valid signature — passes auth, reaches the gate
				"x-github-event": "push",
				"x-github-delivery": "bad-delivery-1",
			},
			body,
		};

		const res = await fetch(vUrl, reqInit);
		// Surfaced as a real 400 with the structured body — NOT swallowed to 200 {ok}.
		expect(res.status).toBe(400);
		const json = (await res.json()) as { validation_errors?: Array<{ path: unknown[] }> };
		expect(json.validation_errors?.some((e) => e.path.join(".") === "orderId")).toBe(true);
		// The workflow body never ran.
		expect(EXECUTIONS).toEqual([]);

		// Resend the SAME delivery id — must 400 again (NOT a cached "duplicate"),
		// proving the validation-failed delivery was not marked processed, so the
		// sender can retry after correcting the payload.
		const res2 = await fetch(vUrl, reqInit);
		expect(res2.status).toBe(400);
	}, 15_000);

	it("TAMPERED body — a valid sig over DIFFERENT bytes is rejected (401), workflow does not run", async () => {
		const signedBody = JSON.stringify({ ref: "refs/heads/main", delivery_id: "tamper-1" });
		const sig = `sha256=${hmacHex(signedBody)}`; // real HMAC over signedBody…
		const tamperedBody = JSON.stringify({ ref: "refs/heads/evil", delivery_id: "tamper-1" }); // …but ship different bytes

		const res = await fetch(url(), {
			method: "POST",
			headers: {
				...baseHeaders,
				"x-hub-signature-256": sig,
				"x-github-event": "push",
				"x-github-delivery": "tamper-1",
			},
			body: tamperedBody,
		});

		expect(res.status).toBe(401);
		const json = (await res.json()) as { error?: string; reason?: string };
		expect(json.error).toBe("Unauthorized");
		expect(json.reason).toBe("signature_mismatch");
		// The whole point: verification ran on the wire bytes, so the
		// mismatch stopped dispatch. Nothing executed.
		expect(EXECUTIONS).toEqual([]);
	}, 15_000);

	it("MISSING signature header — rejected (401), workflow does not run", async () => {
		const body = JSON.stringify({ ref: "refs/heads/main", delivery_id: "missing-1" });

		const res = await fetch(url(), {
			method: "POST",
			headers: {
				...baseHeaders,
				// no x-hub-signature-256
				"x-github-event": "push",
				"x-github-delivery": "missing-1",
			},
			body,
		});

		expect(res.status).toBe(401);
		const json = (await res.json()) as { error?: string; reason?: string };
		expect(json.error).toBe("Unauthorized");
		expect(json.reason).toBe("missing_signature");
		expect(EXECUTIONS).toEqual([]);
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
