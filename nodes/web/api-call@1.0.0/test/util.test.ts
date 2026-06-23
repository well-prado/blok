/**
 * Tests for runApiCall's HTTP-error handling — it must NOT discard the upstream
 * status, body, or Retry-After header on a >=400 response.
 */

import { GlobalError } from "@blokjs/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runApiCall } from "../util";

function mockFetchResponse(opts: {
	status: number;
	statusText?: string;
	headers?: Record<string, string>;
	body?: string;
	json?: unknown;
}): Response {
	const headers = new Headers(opts.headers ?? {});
	return {
		status: opts.status,
		statusText: opts.statusText ?? "",
		ok: opts.status < 400,
		headers,
		json: async () => opts.json,
		text: async () => opts.body ?? "",
	} as unknown as Response;
}

describe("runApiCall — HTTP error handling", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("throws a GlobalError carrying the upstream status code on >=400 (not a generic 500)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				mockFetchResponse({
					status: 429,
					statusText: "Too Many Requests",
					headers: { "content-type": "application/json", "retry-after": "30" },
					json: { error: "rate_limited" },
				}),
			),
		);

		const err = await runApiCall("https://api.example.com/x", "GET", {}, {}, "json").catch((e) => e);
		expect(err).toBeInstanceOf(GlobalError);
		const ge = err as GlobalError;
		expect(ge.context.code).toBe(429);
		expect(ge.context.name).toBe("ApiCallError");
		expect(ge.context.json).toMatchObject({
			status: 429,
			statusText: "Too Many Requests",
			retryAfter: "30",
			retryAfterSeconds: 30,
			body: { error: "rate_limited" },
		});
	});

	it("captures a text body and an HTTP-date Retry-After", async () => {
		const future = new Date(Date.now() + 60_000).toUTCString();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				mockFetchResponse({
					status: 503,
					statusText: "Service Unavailable",
					headers: { "content-type": "text/plain", "retry-after": future },
					body: "down for maintenance",
				}),
			),
		);

		const err = (await runApiCall("https://api.example.com/y", "GET", {}, {}, "json").catch((e) => e)) as GlobalError;
		expect(err.context.code).toBe(503);
		const json = err.context.json as Record<string, unknown>;
		expect(json.body).toBe("down for maintenance");
		expect(typeof json.retryAfterSeconds).toBe("number");
		expect(json.retryAfterSeconds as number).toBeGreaterThan(50);
	});

	it("omits retry fields when no Retry-After header is present", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				mockFetchResponse({
					status: 404,
					statusText: "Not Found",
					headers: { "content-type": "application/json" },
					json: { message: "missing" },
				}),
			),
		);

		const err = (await runApiCall("https://api.example.com/z", "GET", {}, {}, "json").catch((e) => e)) as GlobalError;
		expect(err.context.code).toBe(404);
		const json = err.context.json as Record<string, unknown>;
		expect(json).not.toHaveProperty("retryAfter");
		expect(json.body).toMatchObject({ message: "missing" });
	});

	it("returns the parsed JSON body on a 2xx response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				mockFetchResponse({
					status: 200,
					headers: { "content-type": "application/json" },
					json: { ok: true },
				}),
			),
		);

		const result = await runApiCall("https://api.example.com/ok", "GET", {}, {}, "json");
		expect(result).toEqual({ ok: true });
	});
});
