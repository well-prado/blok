/**
 * `runPage()` (#1002) — driven through the REAL engine: every case here goes
 * `workflow() → normalizer → Configuration → PageNode → @blokjs/inertia`, with
 * counter nodes so "which props actually ran" is observable rather than
 * inferred from the response.
 *
 * Numbered cases map 1:1 to the tests listed in issue #1002 (1–7 from the
 * original body, 8–13 from the v3 update).
 */

import { createHmac } from "node:crypto";
import { http, defineNode, step, workflow } from "@blokjs/core";
import { runPage, runPrecognition, runWorkflow } from "@blokjs/core/testing";
import { always, defer, definePage, merge, optional, shared } from "@blokjs/inertia";
import inertiaNode from "@blokjs/inertia";
import { RESPOND_BRAND } from "@blokjs/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// =============================================================================
// Counter nodes — one per prop, so "did it run" is a fact, not an inference.
// =============================================================================

const counts: Record<string, number> = {};
const calls = (name: string): number => counts[name] ?? 0;
function count(name: string): void {
	counts[name] = calls(name) + 1;
}

const currentUser = defineNode({
	name: "rp-current-user",
	description: "always-prop counter",
	input: z.object({}),
	output: z.object({ id: z.string(), email: z.string() }),
	async execute() {
		count("rp-current-user");
		return { id: "u-1", email: "a@b.c" };
	},
});

const listOrders = defineNode({
	name: "rp-list-orders",
	description: "regular prop, one required input",
	input: z.object({ userId: z.string() }),
	output: z.array(z.object({ id: z.string(), total: z.number() })),
	async execute(_ctx, input) {
		count("rp-list-orders");
		return [
			{ id: `o-${input.userId}`, total: 1 },
			{ id: "o-2", total: 2 },
			{ id: "o-3", total: 3 },
		];
	},
});

const loadFilters = defineNode({
	name: "rp-load-filters",
	description: "optional prop counter",
	input: z.object({}),
	output: z.object({ open: z.boolean() }),
	async execute() {
		count("rp-load-filters");
		return { open: true };
	},
});

const heavyStats = defineNode({
	name: "rp-heavy-stats",
	description: "deferred prop counter (group: dashboard)",
	input: z.object({}),
	output: z.object({ total: z.number() }),
	async execute() {
		count("rp-heavy-stats");
		return { total: 42 };
	},
});

const loadFeed = defineNode({
	name: "rp-load-feed",
	description: "deferred prop counter (group: sidebar)",
	input: z.object({}),
	output: z.object({ items: z.array(z.string()) }),
	async execute() {
		count("rp-load-feed");
		return { items: ["f-1"] };
	},
});

const loadNotices = defineNode({
	name: "rp-load-notices",
	description: "merge-mode prop counter",
	input: z.object({}),
	output: z.object({ data: z.array(z.string()) }),
	async execute() {
		count("rp-load-notices");
		return { data: ["n-1"] };
	},
});

// =============================================================================
// Pages + workflows
// =============================================================================

const OrdersIndex = definePage("RunPage/Orders", {
	auth: always(currentUser),
	orders: listOrders,
	filters: optional(loadFilters),
	notices: merge(loadNotices, { append: "data" }),
	stats: defer(heavyStats, { group: "dashboard" }),
	feed: defer(loadFeed, { group: "sidebar" }),
});

/** The page under test. `orders` reads the SEEDED middleware state (#1002 test 5). */
function ordersWorkflow() {
	return workflow("run-page-orders", { version: "1.0.0", trigger: http.get("/orders") }, (req) => {
		OrdersIndex.render(
			req,
			"page",
			"/orders",
			{ orders: { userId: shared(currentUser, "auth").id } },
			{ version: "v1", flash: { toast: { message: "Saved" } } },
		);
	});
}

/** A workflow that redirects instead of rendering — the `@blokjs/inertia` control response. */
function redirectWorkflow() {
	return workflow("run-page-redirect", { version: "1.0.0", trigger: http.post("/orders") }, () => {
		step("done", inertiaNode, { redirect: "/orders" });
	});
}

/** Not a page at all — `runPage` must refuse it by name. */
const plainNode = defineNode({
	name: "rp-plain",
	description: "returns an ordinary object, no envelope",
	input: z.object({}),
	output: z.object({ ok: z.boolean() }),
	async execute() {
		return { ok: true };
	},
});

function plainWorkflow() {
	return workflow("run-page-plain", { version: "1.0.0", trigger: http.get("/plain") }, () => {
		step("finish", plainNode, {});
	});
}

// --- flash-carrying redirect (#996's cookie shape, signed here so the test
// --- stands on its own until @blokjs/flash lands) ----------------------------

const FLASH_SECRET = "test-secret";

function signFlash(payload: Record<string, unknown>): string {
	const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
	return `${body}.${createHmac("sha256", FLASH_SECRET).update(body).digest("base64url")}`;
}

const redirectBack = defineNode({
	name: "rp-redirect-back",
	description: "302 + a signed flash cookie, the shape @blokjs/flash emits",
	input: z.object({ token: z.string() }),
	output: z.object({
		[RESPOND_BRAND]: z.literal(true),
		status: z.number(),
		headers: z.record(z.string()),
		cookies: z.array(z.string()),
	}),
	async execute(_ctx, input) {
		return {
			[RESPOND_BRAND]: true as const,
			status: 302,
			headers: { Location: "/orders/new" },
			cookies: [`blok_flash=${input.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=120`],
		};
	},
});

function flashRedirectWorkflow(token: string) {
	return workflow("run-page-flash", { version: "1.0.0", trigger: http.post("/orders") }, () => {
		step("back", redirectBack, { token });
	});
}

/** #1011 — a validation step, and the write a dry run must never reach. */
const checkOrder = defineNode({
	name: "rp-check-order",
	description: "Validate an order, returning { ok, errors } rather than throwing.",
	input: z.object({ body: z.record(z.unknown()).optional() }),
	output: z.object({ ok: z.boolean(), errors: z.record(z.unknown()) }),
	async execute(_ctx, input) {
		const errors: Record<string, string> = {};
		const body = input.body ?? {};
		if (typeof body.sku !== "string" || body.sku.length === 0) errors.sku = "Required.";
		if (typeof body.qty !== "number" || body.qty < 1) errors.qty = "Must be at least 1.";
		return { ok: Object.keys(errors).length === 0, errors };
	},
});

const createOrder = defineNode({
	name: "rp-create-order",
	description: "The side effect a dry run must skip.",
	input: z.object({}),
	output: z.object({ id: z.string() }),
	async execute() {
		count("rp-create-order");
		return { id: "o-1" };
	},
});

/** POST /orders: validate (optionally marked), then write. */
function precognitionWorkflow(marked = true) {
	return workflow("run-page-precognition", { version: "1.0.0", trigger: http.post("/orders") }, (req) => {
		step("check", checkOrder, { body: req.body }, marked ? { precognition: true } : {});
		step("create", createOrder, {});
	});
}

const SEED = { auth: { id: "u-1", email: "a@b.c" } };

beforeEach(() => {
	for (const key of Object.keys(counts)) delete counts[key];
});

// =============================================================================

describe("1 — a full page visit", () => {
	it("returns component, props, status and the Inertia response header", async () => {
		const page = await runPage(await ordersWorkflow(), { middleware: SEED });

		expect(page.component).toBe("RunPage/Orders");
		expect(page.status).toBe(200);
		expect(page.headers["X-Inertia"]).toBe("true");
		expect(page.url).toBe("/orders");
		expect(page.version).toBe("v1");
		expect(page.props.auth).toEqual({ id: "u-1", email: "a@b.c" });
		expect(page.props.orders).toHaveLength(3);
		// Lazy modes stay lazy on a full visit, and are announced by group.
		expect(page.props.filters).toBeUndefined();
		expect(page.deferred.sort()).toEqual(["feed", "stats"]);
		expect(page.deferredProps).toEqual({ dashboard: ["stats"], sidebar: ["feed"] });
		// #1009 — a FULL visit replaces props wholesale, so it carries no merge
		// labels at all. Test 10 below asserts them on the partial that does.
		expect(page.mergeProps).toEqual([]);
		expect(calls("rp-heavy-stats")).toBe(0);
		expect(calls("rp-load-filters")).toBe(0);

		page
			.assert()
			.component("RunPage/Orders")
			.has("orders", 3, (o) => o.where("0.id", "o-u-1").etc())
			.where("auth.email", "a@b.c")
			.missing("auth.password")
			.hasFlash("toast.message", "Saved")
			.etc();
	});
});

describe("2 — partial reload", () => {
	it("runs only the requested prop (plus always-props) and says so per step", async () => {
		const page = await runPage(await ordersWorkflow(), { middleware: SEED, partial: ["stats"] });

		expect(page.props.stats).toEqual({ total: 42 });
		expect(page.props.orders).toBeUndefined();
		// The per-prop step IS the state slot — this is the proof, not the counter.
		expect(page.run.step("page.stats")?.executed).toBe(true);
		expect(page.run.step("page.orders")?.executed).toBe(false);
		expect(page.run.state("page.stats")).toEqual({ total: 42 });
		expect(calls("rp-heavy-stats")).toBe(1);
		expect(calls("rp-list-orders")).toBe(0);
		// `always` props survive every filter.
		expect(calls("rp-current-user")).toBe(1);
	});
});

describe("3 — stale asset version", () => {
	it("answers 409 with a location and no page", async ({ onTestFinished }) => {
		// The fixture carries flash, which the 409 must re-sign for the next visit.
		vi.stubEnv("BLOK_FLASH_SECRET", FLASH_SECRET);
		onTestFinished(() => vi.unstubAllEnvs());
		const page = await runPage(await ordersWorkflow(), { middleware: SEED, clientVersion: "old" });

		expect(page.status).toBe(409);
		expect(page.location).toBe("/orders");
		expect(page.component).toBeUndefined();
		page.assertRedirect("/orders").assertFlash("toast.message", "Saved");
	});

	it("renders normally when the versions match", async () => {
		const page = await runPage(await ordersWorkflow(), { middleware: SEED, version: "v1" });
		expect(page.status).toBe(200);
		expect(page.component).toBe("RunPage/Orders");
	});
});

describe("4 — redirect envelope", () => {
	it("reports status and location, and assertRedirect accepts it", async () => {
		const page = await runPage(await redirectWorkflow(), { method: "DELETE" });

		expect(page.status).toBe(303);
		expect(page.location).toBe("/orders");
		expect(page.component).toBeUndefined();
		page.assertRedirect("/orders").status(303).location("/orders");
	});

	it("stays a 302 for a POST", async () => {
		const page = await runPage(await redirectWorkflow(), { method: "POST" });
		expect(page.status).toBe(302);
	});
});

describe("5 — seeded middleware state", () => {
	it("resolves shared() reads without running a middleware chain", async () => {
		const page = await runPage(await ordersWorkflow(), { middleware: { auth: { id: "u-9", email: "z@b.c" } } });

		// `orders` is authored as `{ userId: shared(currentUser, "auth").id }`.
		expect(page.props.orders).toMatchObject([{ id: "o-u-9" }, { id: "o-2" }, { id: "o-3" }]);
		expect(page.run.step("page.orders")?.inputs).toEqual({ userId: "u-9" });
	});
});

describe("6 — mock validation parity with runWorkflow", () => {
	it("throws the same message runWorkflow throws for a schema-violating mock", async () => {
		const bad = { "rp-list-orders": async () => ({ nope: true }) };

		const fromPage = await runPage(await ordersWorkflow(), { middleware: SEED, mock: bad }).catch(
			(error: unknown) => error,
		);
		const fromWorkflow = await runWorkflow(await ordersWorkflow(), undefined, {
			headers: { "x-inertia": "true" },
			state: SEED,
			mock: bad,
		}).catch((error: unknown) => error);

		expect(fromPage).toBeInstanceOf(Error);
		expect((fromPage as Error).message).toContain('Mock for node "rp-list-orders"');
		expect((fromPage as Error).message).toBe((fromWorkflow as Error).message);
	});

	it("accepts a mock that honours the schema", async () => {
		const page = await runPage(await ordersWorkflow(), {
			middleware: SEED,
			mock: { "rp-list-orders": async () => [{ id: "mocked", total: 9 }] },
		});
		expect(page.props.orders).toEqual([{ id: "mocked", total: 9 }]);
	});
});

describe("7 — a workflow that is not a page", () => {
	it("throws, naming the last step", async () => {
		await expect(runPage(await plainWorkflow())).rejects.toThrow(
			/workflow did not end in an Inertia page or redirect.*"finish"/s,
		);
	});
});

describe("8 — exhaustiveness", () => {
	it("fails listing the keys the scope never touched", async () => {
		const page = await runPage(await ordersWorkflow(), { middleware: SEED });

		expect(() => page.assert().has("auth", (a) => a.has("id"))).toThrow(/untouched.*"email"/s);
		// …and passes once they are accounted for, either way.
		page.assert().has("auth", (a) => a.has("id").has("email"));
		page.assert().has("auth", (a) => a.has("id").etc());
	});
});

describe("9 — array counts", () => {
	it("fails when the count does not match", async () => {
		const page = await runPage(await ordersWorkflow(), { middleware: SEED });
		expect(() => page.assert().has("orders", 2)).toThrow(/expected "orders" to have 2 item\(s\), got 3/);
		page.assert().has("orders", 3);
	});
});

describe("10 — reloadOnly / reloadExcept", () => {
	it("re-runs the workflow with only the named props and carries the merge metadata", async () => {
		const page = await runPage(await ordersWorkflow(), { middleware: SEED });
		const before = calls("rp-list-orders");

		const fresh = await page.reloadOnly(["notices"], (p) => p.has("notices").has("auth").has("errors"));

		expect(fresh.props.notices).toEqual({ data: ["n-1"] });
		expect(fresh.props.orders).toBeUndefined();
		expect(fresh.mergeProps).toContain("notices.data");
		expect(fresh.run.step("page.notices")?.executed).toBe(true);
		expect(fresh.run.step("page.orders")?.executed).toBe(false);
		// A REAL second run: the reloaded prop's counter moved, the excluded one did not.
		expect(calls("rp-load-notices")).toBe(2);
		expect(calls("rp-list-orders")).toBe(before);
	});

	it("reloadExcept drops just the named props", async () => {
		const page = await runPage(await ordersWorkflow(), { middleware: SEED });
		const fresh = await page.reloadExcept(["orders"], (p) => p.missing("orders").has("notices").etc());

		expect(fresh.props.orders).toBeUndefined();
		expect(fresh.props.notices).toEqual({ data: ["n-1"] });
		expect(fresh.run.step("page.orders")?.executed).toBe(false);
	});
});

describe("11 — loadDeferredProps", () => {
	it("resolves one group and leaves the other deferred", async () => {
		const page = await runPage(await ordersWorkflow(), { middleware: SEED });
		expect(calls("rp-heavy-stats")).toBe(0);

		const fresh = await page.loadDeferredProps("dashboard", (p) => p.has("stats").missing("feed"));

		expect(fresh.props.stats).toEqual({ total: 42 });
		expect(fresh.run.step("page.stats")?.executed).toBe(true);
		expect(fresh.run.step("page.feed")?.executed).toBe(false);
		expect(calls("rp-heavy-stats")).toBe(1);
		expect(calls("rp-load-feed")).toBe(0);
	});

	it("refuses a group the page never announced", async () => {
		const page = await runPage(await ordersWorkflow(), { middleware: SEED });
		expect(() => page.loadDeferredProps("nope")).toThrow(/announced no such deferred group.*"dashboard"/s);
	});
});

describe("12 — flash on a redirect", () => {
	it("reads the signed flash cookie", async () => {
		const token = signFlash({ errors: { sku: "required" }, flash: { toast: "saved" } });
		const page = await runPage(await flashRedirectWorkflow(token), {
			method: "POST",
			flashSecret: FLASH_SECRET,
		});

		page
			.assertRedirect("/orders/new")
			.status(302)
			.assertFlash("errors.sku", "required")
			.assertFlash("toast", "saved")
			.assertFlashMissing("errors.name");

		expect(() => page.assertRedirect().assertFlash("errors.name")).toThrow(/flash to carry "errors.name"/);
	});

	it("refuses a cookie signed with a different secret", async () => {
		const token = signFlash({ errors: { sku: "required" } });
		const page = await runPage(await flashRedirectWorkflow(token), { method: "POST", flashSecret: "other" });
		expect(() => page.assertRedirect().assertFlash("errors.sku")).toThrow(/did not verify/);
	});
});

describe("13 — precognition (#1011)", () => {
	it("answers 422 with the narrowed errors and never reaches the write", async () => {
		const dry = await runPrecognition(await precognitionWorkflow(), {
			body: { sku: "", qty: -1 },
			fields: ["sku"],
		});

		expect(dry.status).toBe(422);
		expect(dry.errors).toEqual({ sku: "Required." });
		expect(dry.headers.Precognition).toBe("true");
		expect(dry.headers.Vary).toBe("Precognition");
		expect(dry.run.step("create")?.executed).toBe(false);
		expect(calls("rp-create-order")).toBe(0);
	});

	it("answers an empty 204 when the asked-about fields are clean", async () => {
		const dry = await runPrecognition(await precognitionWorkflow(), {
			body: { sku: "SKU-1", qty: -1 },
			fields: "sku",
		});

		expect(dry.status).toBe(204);
		expect(dry.errors).toEqual({});
		expect(dry.headers["Precognition-Success"]).toBe("true");
		expect(dry.run.step("create")?.executed).toBe(false);
	});

	it("validates every field when no field list is given", async () => {
		const dry = await runPrecognition(await precognitionWorkflow(), { body: { sku: "", qty: -1 } });
		expect(dry.status).toBe(422);
		expect(dry.errors).toEqual({ sku: "Required.", qty: "Must be at least 1." });
	});

	it("leaves a workflow with no marked step running normally", async () => {
		const dry = await runPrecognition(await precognitionWorkflow(false), { body: { sku: "SKU-2", qty: 3 } });
		expect(dry.status).toBe(200);
		expect(dry.run.step("create")?.executed).toBe(true);
		expect(calls("rp-create-order")).toBe(1);
	});
});
