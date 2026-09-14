import { runPage } from "@blokjs/core/testing";
import { describe, expect, it } from "vitest";
import dashboard from "../src/workflows/dashboard.js";

const AUTH = { auth: { id: "u-1", email: "ada@example.com" } };

describe("Dashboard (Vue)", () => {
	it("renders the full visit and announces the deferred prop", async () => {
		const page = await runPage(dashboard, { middleware: AUTH });

		page.assert().component("Dashboard").has("orders", 2).has("auth").etc();
		expect(page.deferredProps).toEqual({ dashboard: ["stats"] });
		expect(page.run.step("page.stats")?.executed).toBe(false);
	});

	it("resolves the deferred prop on the follow-up", async () => {
		const page = await runPage(dashboard, { middleware: AUTH });

		const loaded = await page.loadDeferredProps("dashboard");
		expect(loaded.props.stats).toEqual({ revenue: 42_000, orders: 128 });
	});

	it("emits the scroll cursor", async () => {
		const page = await runPage(dashboard, { middleware: AUTH });
		expect(page.scrollProps.posts).toMatchObject({ pageName: "page", nextPage: 2 });
	});
});
