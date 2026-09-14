/**
 * `bun run e2e` for this example.
 *
 * These are `runPage` tests — the real engine, the real page control step, the
 * real serializer, no server and no browser. The real-browser conformance
 * matrix is #1003; when it lands, `e2e` runs that against this app instead.
 */

import { runPage } from "@blokjs/core/testing";
import { describe, expect, it } from "vitest";
import dashboard from "../src/workflows/dashboard.js";

const AUTH = { auth: { id: "u-1", email: "ada@example.com" } };
const STATS = { "dashboard-stats": async () => ({ revenue: 42_000, orders: 128 }) };

describe("Dashboard", () => {
	it("renders the full visit without the deferred prop", async () => {
		const page = await runPage(dashboard, { middleware: AUTH, mock: STATS });

		page.assert().component("Dashboard").has("orders", 2).has("auth").etc();
		expect(page.props.stats).toBeUndefined();
		expect(page.deferredProps).toEqual({ dashboard: ["stats"] });
		expect(page.run.step("page.stats")?.executed).toBe(false);
	});

	it("resolves the Python prop on the deferred follow-up", async () => {
		const page = await runPage(dashboard, { middleware: AUTH, mock: STATS });

		const loaded = await page.loadDeferredProps("dashboard");
		expect(loaded.props.stats).toEqual({ revenue: 42_000, orders: 128 });
		expect(loaded.run.step("page.stats")?.executed).toBe(true);
	});

	it("labels the merge prop on a partial reload only", async () => {
		const page = await runPage(dashboard, { middleware: AUTH, mock: STATS });
		expect(page.mergeProps).toEqual([]);

		const partial = await page.reloadOnly("notifications");
		expect(partial.mergeProps).toEqual(["notifications.data"]);
		expect(partial.matchPropsOn).toEqual(["notifications.data.id"]);
	});

	it("emits a cursor for each scroll prop", async () => {
		const page = await runPage(dashboard, { middleware: AUTH, mock: STATS });

		expect(page.scrollProps.posts).toMatchObject({ pageName: "page", currentPage: 1, nextPage: 2 });
		expect(page.scrollProps.activity).toMatchObject({ pageName: "activity" });
	});

	it("remembers the once prop, so its node stops running", async () => {
		const page = await runPage(dashboard, { middleware: AUTH, mock: STATS });
		expect(page.onceProps.plans).toMatchObject({ prop: "plans" });

		const again = await runPage(dashboard, {
			middleware: AUTH,
			mock: STATS,
			headers: { "x-inertia-except-once-props": "plans" },
		});
		expect(again.run.step("page.plans")?.executed).toBe(false);
		expect(again.onceProps.plans).toMatchObject({ prop: "plans" });
	});

	it("skips every prop the client did not ask for", async () => {
		const page = await runPage(dashboard, { middleware: AUTH, mock: STATS, partial: ["orders"] });

		page.assert().has("orders").has("auth").missing("posts").etc();
		expect(page.run.step("page.posts")?.executed).toBe(false);
	});
});
