import type { UrlMethodPair } from "@inertiajs/core";
import { beforeEach, describe, expect, it } from "vitest";
import { clearRoutes, registerRoutes, route } from "../src/index.js";

// The generated `blok-routes.d.ts` (#998) augments the package the same way.
declare module "../src/index.js" {
	interface Routes {
		"orders.index": { method: "get" };
		"orders.show": { params: { id: string }; method: "get"; component: "Orders/Show" };
		"orders.store": { params: { id: string }; method: "POST" };
	}
}

beforeEach(() => {
	clearRoutes();
	registerRoutes({
		"orders.index": { url: "/orders" },
		"orders.show": { url: "/orders/:id", method: "get", component: "Orders/Show" },
		// Blok workflows declare methods the HTTP way; Inertia wants them lowercase.
		"orders.store": { url: "/orders/:id/items", method: "POST" },
	});
});

describe("route()", () => {
	it("substitutes params into the pattern", () => {
		expect(route("orders.show", { id: "1" }).url).toBe("/orders/1");
	});

	it("throws naming the parameter when one is missing", () => {
		// A caller reaching this at runtime has bypassed the types (untyped JS,
		// or a value that was `undefined` at runtime) — `/orders/undefined` is
		// the silent failure this replaces.
		const call = () => route("orders.show", { id: undefined as unknown as string });
		expect(call).toThrowError(/missing the required parameter "id"/);
	});

	it("builds a param-less route", () => {
		expect(route("orders.index").url).toBe("/orders");
	});

	it("returns a Wayfinder-shaped object carrying the page component", () => {
		const result = route("orders.show", { id: "1" });
		expect({ url: result.url, method: result.method, component: result.component }).toEqual({
			url: "/orders/1",
			method: "get",
			component: "Orders/Show",
		});
		// Structurally an Inertia UrlMethodPair, so `<Link href>`, `<Form action>`
		// and `router.visit()` all accept it and infer the method.
		const pair: UrlMethodPair = result;
		expect(pair.url).toBe("/orders/1");
	});

	it("attaches a component with withComponent() without mutating the original", () => {
		const base = route("orders.index");
		const withComponent = base.withComponent("Orders/Index");
		expect(withComponent.component).toBe("Orders/Index");
		expect(withComponent.url).toBe("/orders");
		expect(base.component).toBeUndefined();
	});

	it("normalises an HTTP-style method to Inertia's lowercase form", () => {
		expect(route("orders.store", { id: "1" }).method).toBe("post");
	});

	it("interpolates into a template string as its url", () => {
		expect(`${route("orders.show", { id: "1" })}`).toBe("/orders/1");
	});

	it("encodes param values and appends leftovers as a query string", () => {
		const result = route("orders.show", { id: "a b/c", page: 2 } as { id: string });
		expect(result.url).toBe("/orders/a%20b%2Fc?page=2");
	});

	it("throws when the route was never registered", () => {
		clearRoutes();
		expect(() => route("orders.index")).toThrowError(/not registered/);
	});
});
