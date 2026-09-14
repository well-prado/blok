import { runPage } from "@blokjs/core/testing";
import { describe, expect, it } from "vitest";
import ordersShow, { index as ordersIndex } from "../src/workflows/orders.js";

const AUTH = { auth: { id: "u-1", email: "ada@example.com" } };

describe("standalone backend", () => {
	it("renders the index page", async () => {
		const page = await runPage(ordersIndex, { middleware: AUTH });
		page.assert().component("Orders/Index").has("orders", 2).has("auth").etc();
	});

	it("renders one order", async () => {
		const page = await runPage(ordersShow, { middleware: AUTH, params: { id: "o-2" } });
		page.assert().component("Orders/Show").has("order").has("auth").etc();
		expect(page.props.order).toMatchObject({ id: "o-2" });
	});

	it("answers a stale asset version with a 409", async () => {
		const page = await runPage(ordersIndex, { middleware: AUTH, clientVersion: "stale" });
		expect(page.status).toBe(409);
		expect(page.headers["X-Inertia-Location"]).toBeDefined();
	});
});
