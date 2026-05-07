/**
 * PR 2 A4 — durable scheduler payload size cap.
 *
 * `HttpTrigger.extractDispatchPayload` caps the serialized JSON at
 * `BLOK_DISPATCH_PAYLOAD_MAX_BYTES` (default 1MB) and throws
 * `PayloadTooLargeError` on overflow. The HTTP transport translates to
 * 413 Payload Too Large with structured info.
 */

import type { Context, RequestContext } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the OTel + Hono server bits like HttpTrigger.test.ts does.
vi.mock("@opentelemetry/api", () => ({
	trace: {
		getTracer: () => ({
			startActiveSpan: (name: string, fn: (span: any) => any) =>
				fn({
					setAttribute: vi.fn(),
					setStatus: vi.fn(),
					recordException: vi.fn(),
					end: vi.fn(),
				}),
		}),
	},
	metrics: {
		getMeter: () => ({
			createCounter: () => ({ add: vi.fn() }),
			createHistogram: () => ({ record: vi.fn() }),
			createGauge: () => ({ record: vi.fn() }),
			createObservableGauge: () => ({ addCallback: vi.fn() }),
		}),
	},
	SpanStatusCode: { OK: 0, ERROR: 1 },
}));

vi.mock("../../src/runner/metrics/opentelemetry_metrics", () => ({
	metricsHandler: vi.fn(),
}));

vi.mock("../../src/Nodes", () => ({ default: {} }));
vi.mock("../../src/Workflows", () => ({ default: {} }));
vi.mock("../../src/AppRoutes", () => {
	const { Hono } = require("hono");
	return { default: new Hono() };
});

import { PayloadTooLargeError } from "@blokjs/runner";
import HttpTrigger from "../../src/runner/HttpTrigger";

class TestHttpTrigger extends HttpTrigger {
	// Test-only accessor for the protected method.
	public callExtractDispatchPayload(ctx: Context): unknown {
		return this.extractDispatchPayload(ctx);
	}
}

function makeCtx(
	body: unknown,
	opts: { headers?: Record<string, string>; method?: string; path?: string } = {},
): Context {
	return {
		id: "test",
		workflow_name: "wf",
		workflow_path: "/wf",
		request: {
			body,
			headers: opts.headers ?? { "content-type": "application/json" },
			params: {},
			query: {},
			method: opts.method ?? "POST",
			path: opts.path ?? "/test",
		} as unknown as RequestContext,
		response: { data: null, contentType: "", success: true, error: null },
		error: { message: [] },
		logger: { log: () => {}, error: () => {} },
		config: {},
		state: {},
		vars: {},
		env: {},
		eventLogger: null,
		signal: undefined,
		_PRIVATE_: null,
	} as unknown as Context;
}

describe("PR 2 A4 — extractDispatchPayload size cap", () => {
	beforeEach(() => {
		process.env.BLOK_DISPATCH_PAYLOAD_MAX_BYTES = undefined;
	});
	afterEach(() => {
		process.env.BLOK_DISPATCH_PAYLOAD_MAX_BYTES = undefined;
	});

	it("returns the payload when under the default 1MB cap", () => {
		const t = new TestHttpTrigger();
		const ctx = makeCtx({ field: "small" });
		const payload = t.callExtractDispatchPayload(ctx);
		expect(payload).toBeDefined();
		expect((payload as { body: unknown }).body).toEqual({ field: "small" });
	});

	it("strips sensitive headers (existing behavior)", () => {
		const t = new TestHttpTrigger();
		const ctx = makeCtx(
			{ x: 1 },
			{
				headers: {
					authorization: "Bearer secret",
					cookie: "session=abc",
					"x-api-key": "sk_live_xxx",
					"x-tenant-id": "t-7",
				},
			},
		);
		const payload = t.callExtractDispatchPayload(ctx) as { headers: Record<string, unknown> };
		expect(payload.headers.authorization).toBeUndefined();
		expect(payload.headers.cookie).toBeUndefined();
		expect(payload.headers["x-api-key"]).toBeUndefined();
		expect(payload.headers["x-tenant-id"]).toBe("t-7");
	});

	it("throws PayloadTooLargeError when serialized size exceeds the default cap", () => {
		const t = new TestHttpTrigger();
		// 2MB body — well over the 1MB default cap.
		const giantBody = { data: "x".repeat(2 * 1024 * 1024) };
		const ctx = makeCtx(giantBody);

		expect(() => t.callExtractDispatchPayload(ctx)).toThrow(PayloadTooLargeError);
	});

	it("error carries actualBytes + maxBytes for transport translation", () => {
		const t = new TestHttpTrigger();
		const giantBody = { data: "x".repeat(2 * 1024 * 1024) };
		const ctx = makeCtx(giantBody);

		try {
			t.callExtractDispatchPayload(ctx);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(PayloadTooLargeError);
			const e = err as PayloadTooLargeError;
			expect(e.actualBytes).toBeGreaterThan(2 * 1024 * 1024);
			expect(e.maxBytes).toBe(1_048_576);
		}
	});

	it("BLOK_DISPATCH_PAYLOAD_MAX_BYTES env var raises the cap", () => {
		process.env.BLOK_DISPATCH_PAYLOAD_MAX_BYTES = String(10 * 1024 * 1024); // 10MB
		const t = new TestHttpTrigger();
		// 2MB body now fits.
		const body = { data: "x".repeat(2 * 1024 * 1024) };
		const ctx = makeCtx(body);
		expect(() => t.callExtractDispatchPayload(ctx)).not.toThrow();
	});

	it("BLOK_DISPATCH_PAYLOAD_MAX_BYTES env var lowers the cap", () => {
		process.env.BLOK_DISPATCH_PAYLOAD_MAX_BYTES = String(1024); // 1KB
		const t = new TestHttpTrigger();
		// 2KB body exceeds the 1KB cap.
		const body = { data: "x".repeat(2048) };
		const ctx = makeCtx(body);
		expect(() => t.callExtractDispatchPayload(ctx)).toThrow(PayloadTooLargeError);
	});

	it("returns null when ctx.request is missing (existing safe-guard)", () => {
		const t = new TestHttpTrigger();
		const ctx = makeCtx({}, {});
		(ctx as unknown as { request: undefined }).request = undefined;
		expect(t.callExtractDispatchPayload(ctx)).toBeNull();
	});

	it("invalid env var value falls back to default", () => {
		process.env.BLOK_DISPATCH_PAYLOAD_MAX_BYTES = "not-a-number";
		const t = new TestHttpTrigger();
		// 2MB body still rejected — env var ignored.
		const body = { data: "x".repeat(2 * 1024 * 1024) };
		const ctx = makeCtx(body);
		expect(() => t.callExtractDispatchPayload(ctx)).toThrow(PayloadTooLargeError);
	});

	// === Security review FW-7 ===
	// Sensitive fields in body / params / query are persisted with values
	// redacted, mirroring the trace-storage sanitize contract. Without the
	// redactor, a delayed POST with `{password, ssn}` writes plaintext to
	// scheduled_dispatches.payload_json (sqlite/PG) where it survives until
	// dispatch fires or the Janitor sweeps the row.

	it("redacts sensitive fields in body (FW-7)", () => {
		const t = new TestHttpTrigger();
		const ctx = makeCtx({
			user: "u1",
			password: "secret123",
			apiKey: "k_xyz",
			nested: { token: "abc" },
		});
		const payload = t.callExtractDispatchPayload(ctx) as { body: Record<string, unknown> };
		expect(payload.body.user).toBe("u1");
		expect(payload.body.password).toBe("[REDACTED]");
		expect(payload.body.apiKey).toBe("[REDACTED]");
		expect((payload.body.nested as Record<string, unknown>).token).toBe("[REDACTED]");
	});

	it("redacts sensitive fields in params (FW-7)", () => {
		const t = new TestHttpTrigger();
		const ctx = makeCtx({});
		(ctx.request as unknown as { params: Record<string, string> }).params = {
			userId: "u1",
			token: "leaky",
		};
		const payload = t.callExtractDispatchPayload(ctx) as { params: Record<string, unknown> };
		expect(payload.params.userId).toBe("u1");
		expect(payload.params.token).toBe("[REDACTED]");
	});

	it("redacts sensitive fields in query (FW-7)", () => {
		const t = new TestHttpTrigger();
		const ctx = makeCtx({});
		(ctx.request as unknown as { query: Record<string, string> }).query = {
			page: "1",
			access_token: "leaky",
		};
		const payload = t.callExtractDispatchPayload(ctx) as { query: Record<string, unknown> };
		expect(payload.query.page).toBe("1");
		expect(payload.query.access_token).toBe("[REDACTED]");
	});

	it("preserves non-sensitive body fields verbatim (FW-7)", () => {
		const t = new TestHttpTrigger();
		const ctx = makeCtx({
			docId: "d-42",
			title: "Hello",
			counts: [1, 2, 3],
			nested: { ok: true },
		});
		const payload = t.callExtractDispatchPayload(ctx) as { body: Record<string, unknown> };
		expect(payload.body.docId).toBe("d-42");
		expect(payload.body.title).toBe("Hello");
		expect(payload.body.counts).toEqual([1, 2, 3]);
		expect(payload.body.nested).toEqual({ ok: true });
	});
});
