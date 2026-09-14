import { runPage, runPrecognition } from "@blokjs/core/testing";
import { beforeAll, describe, expect, it } from "vitest";
import ordersCreate, { page as ordersCreatePage } from "../src/workflows/orders-create.js";

beforeAll(() => {
	// The flash cookie is signed; there is no session store to fall back on.
	process.env.BLOK_FLASH_SECRET ??= "example-secret-for-tests-only";
});

describe("GET /orders/new", () => {
	/**
	 * The persistent AppLayout reads `auth` for the header identity. A page that
	 * does not declare it makes the signed-in user disappear on the way from the
	 * dashboard to the form (#1054 review, M1).
	 */
	it("carries the auth shared prop, so the header identity survives the visit", async () => {
		const page = await runPage(ordersCreatePage, {
			middleware: { auth: { id: "u-1", email: "ada@example.com" } },
		});

		page.assert().component("Orders/Create").has("auth").etc();
		expect(page.props.auth).toEqual({ id: "u-1", email: "ada@example.com" });
	});
});

describe("POST /orders", () => {
	it("bounces back with the validation errors", async () => {
		const page = await runPage(ordersCreate, { method: "POST", input: { sku: "", total: 0 } });

		page.assertRedirect("/orders/new").status(303).assertFlash("errors.sku", "Required.");
		expect(page.run.step("create")?.executed).toBe(false);
	});

	it("creates the order and flashes a toast", async () => {
		const page = await runPage(ordersCreate, {
			method: "POST",
			input: { sku: "BLOK-9", total: 10 },
			headers: { referer: "/orders/new" },
		});

		page.assertRedirect("/orders/new").status(303).assertFlash("toast", "BLOK-9 created.");
		expect(page.run.step("reject")?.executed).toBe(false);
	});

	it("never reaches the write on a Precognition dry run", async () => {
		const dry = await runPrecognition(ordersCreate, { body: { sku: "", total: 0 }, fields: ["sku"] });

		expect(dry.status).toBe(422);
		expect(dry.errors.sku).toBe("Required.");
		expect(dry.run.step("create")?.executed).toBe(false);
	});

	it("answers 204 when the asked-about fields are clean", async () => {
		const dry = await runPrecognition(ordersCreate, { body: { sku: "BLOK-9", total: 10 } });

		expect(dry.status).toBe(204);
		expect(dry.run.step("create")?.executed).toBe(false);
	});
});
