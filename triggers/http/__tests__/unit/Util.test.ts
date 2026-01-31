import { describe, expect, it } from "vitest";
import { handleDynamicRoute, validateRoute } from "../../src/runner/Util";

describe("validateRoute()", () => {
	it("should return true for exact match", () => {
		expect(validateRoute("/api/users", "/api/users")).toBe(true);
	});

	it("should return true for dynamic route with :param", () => {
		expect(validateRoute("/api/users/:id", "/api/users/123")).toBe(true);
	});

	it("should return false for non-matching route", () => {
		expect(validateRoute("/api/users", "/api/posts")).toBe(false);
	});

	it("should return false for null dynamicRoute", () => {
		expect(validateRoute(null as unknown as string, "/api/users")).toBe(false);
	});

	it("should return false for null actualRoute", () => {
		expect(validateRoute("/api/users", null as unknown as string)).toBe(false);
	});

	it("should return false for empty dynamicRoute", () => {
		expect(validateRoute("", "/api/users")).toBe(false);
	});

	it("should handle wildcard (*)", () => {
		expect(validateRoute("/api/*", "/api/anything/here")).toBe(true);
	});

	it("should match nested dynamic routes", () => {
		expect(validateRoute("/api/:version/:resource", "/api/v1/users")).toBe(true);
	});

	it("should not match shorter paths", () => {
		expect(validateRoute("/api/:version/:resource", "/api/v1")).toBe(false);
	});

	it("should match root path", () => {
		expect(validateRoute("/", "/")).toBe(true);
	});
});

describe("handleDynamicRoute()", () => {
	it("should extract single param from route", () => {
		const params = handleDynamicRoute("/api/users/:id", "/api/users/42", {});
		expect(params.id).toBe("42");
	});

	it("should extract multiple params from route", () => {
		const params = handleDynamicRoute("/api/:version/:resource", "/api/v1/users", {});
		expect(params.version).toBe("v1");
		expect(params.resource).toBe("users");
	});

	it("should preserve existing params for routes with no dynamic params", () => {
		const params = handleDynamicRoute("/api/static", "/api/static", { existing: "val" });
		expect(params.existing).toBe("val");
	});

	it("should handle fallback splitting when regex does not match", () => {
		const params = handleDynamicRoute("/:x/:y/:z", "/a/b/c", {});
		expect(params.x).toBeDefined();
		expect(params.y).toBeDefined();
		expect(params.z).toBeDefined();
	});
});
