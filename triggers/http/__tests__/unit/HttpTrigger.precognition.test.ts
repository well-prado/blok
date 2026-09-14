/**
 * #1011 tests 3–9 — validation errors, error bags and Precognition dry runs
 * over a REAL `HttpTrigger`, driven with `app.fetch(...)`.
 *
 * Nothing here is simulated. The validation step is the shipped
 * `@blokjs/validate` node with a real Zod schema; the bounce-back is
 * `@blokjs/inertia`'s `redirectBack()`; the flash cookie really survives the
 * redirect and is really consumed by the next render. The precognition stop is
 * the runner's, so the "did the write run?" assertions read a probe the write
 * node writes to — the only honest way to prove a step did not execute.
 *
 * Harness mirrors `HttpTrigger.inertiaMiddleware.test.ts` (#996): same OTel /
 * metrics / server mocks, `../../src/Nodes` extended with the app-side nodes an
 * Inertia project supplies itself, and `@blokjs/inertia` imported without being
 * a manifest dependency (the workspace link resolves it — see that file's note).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { makeOtelApiMock } = await vi.hoisted(() => import("../helpers/otel-api-mock.js"));
vi.mock("@opentelemetry/api", () => makeOtelApiMock());

vi.mock("../../src/runner/metrics/opentelemetry_metrics", () => ({
	bootstrapMetrics: async () => ({ meter: {}, metricsHandler: () => {} }),
	resetBootstrap: () => {},
	metricsHandler: vi.fn(),
}));

vi.mock("../../src/AppRoutes", () => {
	const { Hono } = require("hono");
	return { default: new Hono() };
});

/** Cross-boundary recorder: written by the write node, read by the tests. */
const probe = vi.hoisted(() => ({ created: [] as unknown[] }));

vi.mock("../../src/Nodes", async (importActual) => {
	const actual = (await importActual()) as { default: Record<string, unknown> };
	const { defineNode } = await import("@blokjs/runner");
	const { redirectBack } = await import("@blokjs/inertia");
	const { z } = await import("zod");

	/** The side effect a dry run must never reach. */
	const createOrder = defineNode({
		name: "test/create-order",
		description: "The write a precognition request must not perform.",
		input: z.object({ order: z.unknown() }),
		output: z.object({ id: z.string() }),
		async execute(_ctx, input) {
			probe.created.push(input.order);
			return { id: `o-${probe.created.length}` };
		},
	});

	/** The failed-validation ending: bounce back with the errors flashed. */
	const bounce = defineNode({
		name: "test/bounce",
		description: "Redirect back with the validation errors flashed.",
		input: z.object({ errors: z.record(z.unknown()) }),
		output: z.unknown(),
		async execute(ctx, input) {
			const request = ctx.request as unknown as { headers?: Record<string, unknown>; method?: string };
			return redirectBack(
				{ headers: request?.headers, method: request?.method },
				{ errors: input.errors, fallback: "/orders" },
			);
		},
	});

	return {
		default: { ...actual.default, "test/create-order": createOrder, "test/bounce": bounce },
	};
});

vi.mock("../../src/Workflows", async () => {
	const { z } = await import("zod");

	const ref = (step: string, ...path: string[]) => ({ $ref: { step, path } });

	/** `qty` is validated too — test 6 proves `Validate-Only` drops its error. */
	const OrderSchema = z.object({
		sku: z.string().min(1, "Required."),
		qty: z.number().min(1, "Must be at least 1."),
	});

	/**
	 * POST/PUT /orders: validate, then either write or bounce.
	 *
	 * `precognition` is set on the validate step ONLY in the `marked` variant, so
	 * test 9 can send the very same headers at a workflow that never opted in.
	 */
	const writeFlow = (name: string, method: string, path: string, marked: boolean) => ({
		_blokV2: true,
		_config: {
			name,
			version: "1.0.0",
			trigger: { http: { method, path } },
			steps: [
				{
					id: "check",
					use: "@blokjs/validate",
					inputs: { schema: OrderSchema, data: ref("@trigger", "body") },
					...(marked ? { precognition: true } : {}),
				},
				{
					id: "route",
					branch: {
						when: "ctx.state.check.ok",
						then: [{ id: "create", use: "test/create-order", inputs: { order: ref("check", "data") } }],
						else: [{ id: "reject", use: "test/bounce", inputs: { errors: ref("check", "errors") } }],
					},
				},
			],
		},
	});

	/** GET /orders: the render that consumes the flash the redirect left. */
	const ordersPage = {
		_blokV2: true,
		_config: {
			name: "orders",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/orders" } },
			steps: [
				{
					id: "flash",
					use: "@blokjs/flash",
					inputs: { op: "read", cookieHeader: ref("@trigger", "headers", "cookie") },
				},
				{
					id: "render",
					use: "@blokjs/inertia",
					inputs: {
						component: "Orders/Index",
						version: "v1",
						url: "/orders",
						props: {},
						errors: ref("flash", "errors"),
						errorBag: ref("flash", "bag"),
						flash: ref("flash", "flash"),
						cookies: [ref("flash", "cookie")],
					},
				},
			],
		},
	};

	return {
		default: {
			orders: ordersPage,
			"orders-create": writeFlow("orders-create", "POST", "/orders", true),
			"orders-update": writeFlow("orders-update", "PUT", "/orders/:id", true),
			"orders-plain": writeFlow("orders-plain", "POST", "/plain-orders", false),
		},
	};
});

const mockServer = { close: vi.fn(), on: vi.fn() };
vi.mock("@hono/node-server", () => ({
	serve: vi.fn((_opts: unknown, cb?: () => void) => {
		cb?.();
		return mockServer;
	}),
}));
vi.mock("@hono/node-server/serve-static", () => ({ serveStatic: () => vi.fn() }));
vi.mock("@hono/node-server/utils/response", () => ({ RESPONSE_ALREADY_SENT: new Response(null) }));

import { WorkflowRegistry } from "@blokjs/runner";
import HttpTrigger from "../../src/runner/HttpTrigger.js";

const INERTIA = { "x-inertia": "true" };
const JSON_POST = { ...INERTIA, "content-type": "application/json", referer: "/orders" };
const INVALID = JSON.stringify({ sku: "", qty: -1 });
let previousSecret: string | undefined;

type App = ReturnType<HttpTrigger["getApp"]>;

async function buildApp(): Promise<App> {
	const trigger = new HttpTrigger();
	await trigger.listen();
	return trigger.getApp();
}

function fetchIt(app: App, path: string, init?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, init));
}

/** `blok_flash=<token>; Path=/; …` -> `blok_flash=<token>` for a Cookie header. */
function cookiePair(setCookie: string | null): string {
	expect(setCookie).toBeTruthy();
	return (setCookie as string).split(";")[0];
}

describe("HttpTrigger — validation + Precognition (#1011)", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
		previousSecret = process.env.BLOK_FLASH_SECRET;
		process.env.BLOK_FLASH_SECRET = "precognition-flash-secret";
		probe.created.length = 0;
	});

	afterEach(() => {
		// biome-ignore lint/performance/noDelete: the var must be ABSENT afterwards, not the string "undefined".
		if (previousSecret === undefined) delete process.env.BLOK_FLASH_SECRET;
		else process.env.BLOK_FLASH_SECRET = previousSecret;
	});

	// Test 3
	it("3 — POST invalid → 303 + a flash cookie whose errors show once on the next GET", async () => {
		const app = await buildApp();

		const posted = await fetchIt(app, "/orders", { method: "POST", headers: JSON_POST, body: INVALID });
		expect(posted.status).toBe(303);
		expect(posted.headers.get("location")).toBe("/orders");
		expect(probe.created).toEqual([]);
		const flashCookie = posted.headers.get("set-cookie");
		expect(flashCookie).toContain("blok_flash=");

		const shown = await fetchIt(app, "/orders", {
			headers: { ...INERTIA, cookie: cookiePair(flashCookie) },
		});
		expect(shown.status).toBe(200);
		const page = (await shown.json()) as { props: { errors: Record<string, string> } };
		expect(page.props.errors.sku).toBe("Required.");
		expect(page.props.errors.qty).toBe("Must be at least 1.");

		// One-shot: the browser dropped the cookie, so the second GET has `{}` —
		// which is still PRESENT, because `errors` is an always prop.
		const again = await fetchIt(app, "/orders", { headers: INERTIA });
		const second = (await again.json()) as { props: { errors: Record<string, string> } };
		expect(second.props.errors).toEqual({});
	});

	// Test 4
	it("4 — `X-Inertia-Error-Bag` rides the cookie and nests the errors on the next GET", async () => {
		const app = await buildApp();

		const posted = await fetchIt(app, "/orders", {
			method: "POST",
			headers: { ...JSON_POST, "x-inertia-error-bag": "createOrder" },
			body: INVALID,
		});
		expect(posted.status).toBe(303);

		// The bounce-back GET carries NO bag header — the name has to have been
		// persisted with the errors for this to nest.
		const shown = await fetchIt(app, "/orders", {
			headers: { ...INERTIA, cookie: cookiePair(posted.headers.get("set-cookie")) },
		});
		const page = (await shown.json()) as {
			props: { errors: Record<string, Record<string, string>> };
		};
		expect(page.props.errors.createOrder?.sku).toBe("Required.");
		expect(page.props.errors.sku).toBeUndefined();
	});

	// Test 5
	it("5 — PUT invalid redirects with 303, never 302", async () => {
		const app = await buildApp();
		const put = await fetchIt(app, "/orders/o-1", { method: "PUT", headers: JSON_POST, body: INVALID });
		expect(put.status).toBe(303);
		expect(probe.created).toEqual([]);
	});

	// Test 6
	it("6 — a dry run scoped to `sku` answers 422 with only that error, and never writes", async () => {
		const app = await buildApp();
		const res = await fetchIt(app, "/orders", {
			method: "POST",
			headers: { ...JSON_POST, precognition: "true", "precognition-validate-only": "sku" },
			body: INVALID,
		});

		expect(res.status).toBe(422);
		expect(res.headers.get("precognition")).toBe("true");
		expect(res.headers.get("vary")).toContain("Precognition");
		expect(await res.json()).toEqual({ errors: { sku: "Required." } });
		// `qty: -1` is invalid too — the client did not ask about it.
		expect(probe.created).toEqual([]);
		expect(res.headers.get("set-cookie")).toBeNull();
	});

	// Test 7
	it("7 — a dry run whose asked-about fields are clean answers an empty 204", async () => {
		const app = await buildApp();
		const res = await fetchIt(app, "/orders", {
			method: "POST",
			headers: { ...JSON_POST, precognition: "true", "precognition-validate-only": "sku" },
			// `qty` is STILL invalid; the client only asked about `sku`.
			body: INVALID.replace('"sku":""', '"sku":"SKU-1"'),
		});

		expect(res.status).toBe(204);
		expect(res.headers.get("precognition")).toBe("true");
		expect(res.headers.get("precognition-success")).toBe("true");
		expect(res.headers.get("vary")).toContain("Precognition");
		expect(await res.text()).toBe("");
		expect(probe.created).toEqual([]);
	});

	// Test 8
	it("8 — with no `Precognition-Validate-Only`, every field is reported", async () => {
		const app = await buildApp();
		const res = await fetchIt(app, "/orders", {
			method: "POST",
			headers: { ...JSON_POST, precognition: "true" },
			body: INVALID,
		});

		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({
			errors: { sku: "Required.", qty: "Must be at least 1." },
		});
		expect(probe.created).toEqual([]);
	});

	// Test 9
	it("9 — the same headers at a workflow with no marked step run it normally", async () => {
		const app = await buildApp();
		const res = await fetchIt(app, "/plain-orders", {
			method: "POST",
			headers: { ...JSON_POST, precognition: "true", "precognition-validate-only": "sku" },
			body: JSON.stringify({ sku: "SKU-9", qty: 2 }),
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("precognition")).toBeNull();
		expect(res.headers.get("vary") ?? "").not.toContain("Precognition");
		// The write RAN: no accidental dry run.
		expect(probe.created).toEqual([{ sku: "SKU-9", qty: 2 }]);
	});

	it("a NON-precognition request on a precognition route still carries `Vary: Precognition`", async () => {
		const app = await buildApp();
		const res = await fetchIt(app, "/orders", {
			method: "POST",
			headers: JSON_POST,
			body: JSON.stringify({ sku: "SKU-2", qty: 1 }),
		});
		expect(res.headers.get("vary")).toContain("Precognition");
		expect(probe.created).toEqual([{ sku: "SKU-2", qty: 1 }]);
	});
});
