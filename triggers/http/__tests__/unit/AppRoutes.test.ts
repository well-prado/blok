import { describe, expect, it } from "vitest";
import app from "../../src/AppRoutes";

describe("AppRoutes", () => {
	it("should export a Hono app", () => {
		expect(app).toBeDefined();
		expect(typeof app.fetch).toBe("function");
	});

	it("should handle GET / route and return HTML", async () => {
		const res = await app.request("/");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("Welcome to blok");
	});
});
