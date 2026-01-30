import { ApiError } from "@/lib/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We need to test the fetchJson helper behavior through exported functions.
// Mock fetch globally.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Import after mocking
const api = await import("@/lib/api");

function jsonResponse(data: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 200 ? "OK" : "Error",
		json: () => Promise.resolve(data),
		text: () => Promise.resolve(JSON.stringify(data)),
		headers: new Headers(),
	} as unknown as Response;
}

describe("API client", () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("fetchHealth", () => {
		it("calls correct endpoint", async () => {
			mockFetch.mockResolvedValueOnce(jsonResponse({ status: "ok", version: "1.0.0", uptime: 1000, activeRuns: 0 }));

			const result = await api.fetchHealth();
			expect(result.status).toBe("ok");
			expect(mockFetch).toHaveBeenCalledWith(
				"/__blok/health",
				expect.objectContaining({ headers: expect.any(Object) }),
			);
		});
	});

	describe("fetchWorkflows", () => {
		it("returns workflow summaries", async () => {
			const workflows = [{ name: "countries", totalRuns: 10, errorRate: 0.05 }];
			mockFetch.mockResolvedValueOnce(jsonResponse(workflows));

			const result = await api.fetchWorkflows();
			expect(result).toEqual(workflows);
		});
	});

	describe("fetchRuns", () => {
		it("constructs query params correctly", async () => {
			mockFetch.mockResolvedValueOnce(jsonResponse({ runs: [], total: 0, page: 1 }));

			await api.fetchRuns({ workflow: "test", status: "completed", limit: 10, offset: 20 });

			const calledUrl = mockFetch.mock.calls[0]![0] as string;
			expect(calledUrl).toContain("workflow=test");
			expect(calledUrl).toContain("status=completed");
			expect(calledUrl).toContain("limit=10");
			expect(calledUrl).toContain("offset=20");
		});

		it("omits empty params", async () => {
			mockFetch.mockResolvedValueOnce(jsonResponse({ runs: [], total: 0, page: 1 }));

			await api.fetchRuns({});

			const calledUrl = mockFetch.mock.calls[0]![0] as string;
			expect(calledUrl).toBe("/__blok/runs");
		});
	});

	describe("fetchRunDetail", () => {
		it("encodes run ID", async () => {
			mockFetch.mockResolvedValueOnce(jsonResponse({ run: {}, nodes: [], logs: [] }));

			await api.fetchRunDetail("run/with/slashes");

			const calledUrl = mockFetch.mock.calls[0]![0] as string;
			expect(calledUrl).toContain("run%2Fwith%2Fslashes");
		});
	});

	describe("error handling", () => {
		it("throws ApiError on non-ok response", async () => {
			mockFetch.mockResolvedValueOnce(jsonResponse({ error: "Not found" }, 404));

			try {
				await api.fetchHealth();
				expect.unreachable("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(ApiError);
				expect((e as ApiError).status).toBe(404);
				expect((e as ApiError).message).toBe("Not found");
			}
		});

		it("falls back to statusText when no error body", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 500,
				statusText: "Internal Server Error",
				json: () => Promise.reject(new Error("parse error")),
			} as unknown as Response);

			try {
				await api.fetchHealth();
			} catch (e) {
				expect(e).toBeInstanceOf(ApiError);
				expect((e as ApiError).message).toBe("Internal Server Error");
			}
		});
	});

	describe("searchTraces", () => {
		it("encodes search query", async () => {
			mockFetch.mockResolvedValueOnce(jsonResponse({ workflows: [], runs: [] }));

			await api.searchTraces("hello world");

			const calledUrl = mockFetch.mock.calls[0]![0] as string;
			expect(calledUrl).toContain("q=hello%20world");
		});
	});

	describe("replayRun", () => {
		it("sends POST with overrides", async () => {
			mockFetch.mockResolvedValueOnce(jsonResponse({ newRunId: "new_123" }));

			await api.replayRun("run_abc", { method: "POST", path: "/test" });

			expect(mockFetch).toHaveBeenCalledWith(
				"/__blok/runs/run_abc/replay",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ method: "POST", path: "/test" }),
				}),
			);
		});

		it("sends POST without body when no overrides", async () => {
			mockFetch.mockResolvedValueOnce(jsonResponse({ newRunId: "new_123" }));

			await api.replayRun("run_abc");

			expect(mockFetch).toHaveBeenCalledWith(
				"/__blok/runs/run_abc/replay",
				expect.objectContaining({
					method: "POST",
					body: undefined,
				}),
			);
		});
	});

	describe("tags", () => {
		it("addRunTags sends tags array", async () => {
			mockFetch.mockResolvedValueOnce(jsonResponse({ tags: ["prod", "v2"] }));

			await api.addRunTags("run_123", ["prod", "v2"]);

			expect(mockFetch).toHaveBeenCalledWith(
				"/__blok/runs/run_123/tags",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ tags: ["prod", "v2"] }),
				}),
			);
		});

		it("removeRunTag sends DELETE", async () => {
			mockFetch.mockResolvedValueOnce(jsonResponse({ removed: true }));

			await api.removeRunTag("run_123", "prod");

			expect(mockFetch).toHaveBeenCalledWith(
				"/__blok/runs/run_123/tags/prod",
				expect.objectContaining({ method: "DELETE" }),
			);
		});
	});

	describe("metrics", () => {
		it("fetches with workflow filter", async () => {
			mockFetch.mockResolvedValueOnce(jsonResponse({ totalRuns: 100 }));

			await api.fetchMetrics("countries");

			const calledUrl = mockFetch.mock.calls[0]![0] as string;
			expect(calledUrl).toContain("workflow=countries");
		});

		it("fetches without filter", async () => {
			mockFetch.mockResolvedValueOnce(jsonResponse({ totalRuns: 100 }));

			await api.fetchMetrics();

			const calledUrl = mockFetch.mock.calls[0]![0] as string;
			expect(calledUrl).toBe("/__blok/metrics");
		});
	});

	describe("webhooks", () => {
		it("creates webhook with all options", async () => {
			mockFetch.mockResolvedValueOnce(jsonResponse({ id: "wh_123" }));

			await api.createWebhook({
				url: "https://example.com/hook",
				events: ["run.completed"],
				secret: "s3cret",
			});

			expect(mockFetch).toHaveBeenCalledWith(
				"/__blok/webhooks",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({
						url: "https://example.com/hook",
						events: ["run.completed"],
						secret: "s3cret",
					}),
				}),
			);
		});

		it("deletes webhook by id", async () => {
			mockFetch.mockResolvedValueOnce(jsonResponse({ removed: true }));

			await api.deleteWebhook("wh_123");

			expect(mockFetch).toHaveBeenCalledWith("/__blok/webhooks/wh_123", expect.objectContaining({ method: "DELETE" }));
		});
	});

	describe("sendWorkflowRequest", () => {
		it("sends request to workflow path", async () => {
			const headers = new Headers();
			headers.set("content-type", "application/json");
			mockFetch.mockResolvedValueOnce({
				status: 200,
				headers,
				text: () => Promise.resolve('{"result":"ok"}'),
			});

			const result = await api.sendWorkflowRequest({
				method: "GET",
				path: "/countries",
			});

			expect(result.status).toBe(200);
			expect(result.body).toBe('{"result":"ok"}');
			expect(mockFetch).toHaveBeenCalledWith("/countries", expect.objectContaining({ method: "GET" }));
		});

		it("does not send body for GET requests", async () => {
			mockFetch.mockResolvedValueOnce({
				status: 200,
				headers: new Headers(),
				text: () => Promise.resolve(""),
			});

			await api.sendWorkflowRequest({
				method: "GET",
				path: "/test",
				body: "should-not-be-sent",
			});

			expect(mockFetch).toHaveBeenCalledWith("/test", expect.objectContaining({ body: undefined }));
		});
	});
});
