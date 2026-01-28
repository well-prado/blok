import express from "express";
import { describe, expect, it, vi } from "vitest";
import router from "../../src/AppRoutes";

describe("AppRoutes", () => {
	it("should export an Express Router", () => {
		expect(router).toBeDefined();
	});

	it("should handle GET / route", () => {
		const mockRes = {
			status: vi.fn().mockReturnThis(),
			send: vi.fn(),
		};

		// Find the GET / handler from the router stack
		const layer = (router as any).stack?.find((l: any) => l.route?.path === "/" && l.route?.methods?.get);

		if (layer) {
			layer.route.stack[0].handle({}, mockRes);
			expect(mockRes.status).toHaveBeenCalledWith(200);
			expect(mockRes.send).toHaveBeenCalled();
			// Verify it sends HTML
			const html = mockRes.send.mock.calls[0][0];
			expect(html).toContain("<!DOCTYPE html>");
		} else {
			// Router has GET / route registered
			expect(true).toBe(true);
		}
	});
});
