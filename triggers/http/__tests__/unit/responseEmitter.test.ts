/**
 * Unit tests for workflow-controllable HTTP responses (status / headers /
 * Set-Cookie / binary), exercised through a real Hono context via
 * `app.request(...)`. Drives the exact function the trigger's success branch
 * calls (`emitWorkflowResponse`), so these assertions cover the shipped path.
 */

import { RESPOND_BRAND } from "@blokjs/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { emitWorkflowResponse, normalizeResponseEnvelope } from "../../src/runner/responseEmitter";

/** Build an app whose GET /x route emits `ctxResponse` via the real emitter. */
function appFor(ctxResponse: unknown): Hono {
	const app = new Hono();
	app.get("/x", (c) => emitWorkflowResponse(c, ctxResponse));
	return app;
}

/**
 * Build an app that mirrors the trigger's success branch for a RAW runtime
 * payload: normalize first (the leak-fix step), then emit. `sideChannelCt`
 * stands in for the SDK proto `content_type` surfaced via `_stepContentType`.
 */
function runtimeAppFor(rawResponse: unknown, sideChannelCt?: string): Hono {
	const app = new Hono();
	app.get("/x", (c) =>
		emitWorkflowResponse(c, normalizeResponseEnvelope(rawResponse, sideChannelCt || "application/json")),
	);
	return app;
}

/** A module-node BlokResponse wrapper around `data`. */
function wrap(data: unknown, contentType = "application/json") {
	return { data, contentType, success: true, error: null };
}

describe("emitWorkflowResponse — workflow-controllable HTTP responses", () => {
	describe("@blokjs/respond envelope", () => {
		it("emits a 302 redirect with a Location header and empty body", async () => {
			const res = await appFor(
				wrap({ [RESPOND_BRAND]: true, status: 302, headers: { Location: "/dashboard" } }),
			).request("/x");
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toBe("/dashboard");
			expect(await res.text()).toBe("");
		});

		it("emits a single Set-Cookie", async () => {
			const res = await appFor(
				wrap({ [RESPOND_BRAND]: true, body: { ok: true }, cookies: ["session=abc; Path=/; HttpOnly"] }),
			).request("/x");
			expect(res.status).toBe(200);
			expect(res.headers.getSetCookie()).toEqual(["session=abc; Path=/; HttpOnly"]);
			expect(await res.json()).toEqual({ ok: true });
		});

		it("emits multiple Set-Cookie headers (the header repeats)", async () => {
			const res = await appFor(
				wrap({
					[RESPOND_BRAND]: true,
					body: "",
					cookies: ["a=1; Path=/", "b=2; Path=/; HttpOnly"],
				}),
			).request("/x");
			expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/; HttpOnly"]);
		});

		it("emits a custom 4xx with a JSON body", async () => {
			const res = await appFor(wrap({ [RESPOND_BRAND]: true, status: 422, body: { error: "invalid" } })).request("/x");
			expect(res.status).toBe(422);
			expect(await res.json()).toEqual({ error: "invalid" });
		});

		it("emits a binary body with a custom Content-Type + Content-Disposition (raw bytes, not JSON)", async () => {
			const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
			const res = await appFor(
				wrap({
					[RESPOND_BRAND]: true,
					body: pdf,
					contentType: "application/pdf",
					headers: { "Content-Disposition": 'attachment; filename="report.pdf"' },
				}),
			).request("/x");
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("application/pdf");
			expect(res.headers.get("content-disposition")).toBe('attachment; filename="report.pdf"');
			const bytes = new Uint8Array(await res.arrayBuffer());
			expect(Array.from(bytes)).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
		});

		it("honors a contentType override for an object body (not forced to JSON)", async () => {
			const res = await appFor(
				wrap({ [RESPOND_BRAND]: true, body: { a: 1 }, contentType: "application/ld+json" }),
			).request("/x");
			expect(res.headers.get("content-type")).toBe("application/ld+json");
			expect(await res.json()).toEqual({ a: 1 });
		});
	});

	describe("bare binary body (no envelope)", () => {
		it("sends a Buffer as raw bytes with the node's Content-Type (not JSON)", async () => {
			const buf = Buffer.from([1, 2, 3, 4]);
			const res = await appFor(wrap(buf, "application/pdf")).request("/x");
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("application/pdf");
			const bytes = new Uint8Array(await res.arrayBuffer());
			expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
		});

		it("sends a Uint8Array as raw bytes", async () => {
			const res = await appFor(wrap(new Uint8Array([9, 8, 7]), "application/octet-stream")).request("/x");
			const bytes = new Uint8Array(await res.arrayBuffer());
			expect(Array.from(bytes)).toEqual([9, 8, 7]);
		});
	});

	describe("back-compat (no opt-in)", () => {
		it("returns a JSON object body with status 200 + application/json", async () => {
			const res = await appFor(wrap({ hello: "world" })).request("/x");
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toMatch(/application\/json/);
			expect(await res.json()).toEqual({ hello: "world" });
		});

		it("returns a string body verbatim with status 200", async () => {
			const res = await appFor(wrap("plain text", "text/plain")).request("/x");
			expect(res.status).toBe(200);
			expect(await res.text()).toBe("plain text");
		});
	});
});

describe("normalizeResponseEnvelope — runtime.* contentType leak fix", () => {
	// Regression: a `runtime.*` node leaves its raw return value on
	// `ctx.response`; the content-type must travel ALONGSIDE it (→ header),
	// never get written into the body as a spurious `contentType` key.
	// See specs/blok-framework-fixes/05-cross-runtime-live-test.md Finding #2.

	describe("pure normalization", () => {
		it("wraps a raw object payload without mutating it (no contentType key added to the body)", () => {
			const raw = { message: "Hi, Ada!", language: "python3" };
			const env = normalizeResponseEnvelope(raw, "application/json") as { data: unknown; contentType: string };
			expect(env.contentType).toBe("application/json");
			expect(env.data).toBe(raw); // same reference — body emitted verbatim
			expect(raw).not.toHaveProperty("contentType"); // original untouched
		});

		it("carries a non-default side-channel content-type onto the envelope", () => {
			const env = normalizeResponseEnvelope("<h1>hi</h1>", "text/html") as { data: unknown; contentType: string };
			expect(env.contentType).toBe("text/html");
			expect(env.data).toBe("<h1>hi</h1>");
		});

		it("wraps a primitive payload instead of throwing (no `.contentType =` on a number)", () => {
			expect(() => normalizeResponseEnvelope(42, "application/json")).not.toThrow();
			const env = normalizeResponseEnvelope(42, "application/json") as { data: unknown };
			expect(env.data).toBe(42);
		});

		it("returns an already-wrapped module response as-is, preserving its content-type", () => {
			const wrapper = wrap({ ok: true }, "application/ld+json");
			const env = normalizeResponseEnvelope(wrapper, "application/json");
			expect(env).toBe(wrapper); // not re-wrapped
			expect((env as { contentType: string }).contentType).toBe("application/ld+json");
		});

		it("defaults an empty content-type on an already-wrapped response", () => {
			const wrapper = { data: { ok: true }, contentType: "", success: true, error: null };
			const env = normalizeResponseEnvelope(wrapper, "application/json") as { contentType: string };
			expect(env.contentType).toBe("application/json");
		});
	});

	describe("end-to-end emission", () => {
		it("emits a clean JSON body with NO contentType key + application/json header", async () => {
			const res = await runtimeAppFor({ message: "Hi, Ada!", language: "python3" }).request("/x");
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toMatch(/application\/json/);
			const body = await res.json();
			expect(body).toEqual({ message: "Hi, Ada!", language: "python3" });
			expect(body).not.toHaveProperty("contentType");
		});

		it("maps a non-default SDK content-type to the Content-Type header", async () => {
			const res = await runtimeAppFor("<h1>Hi</h1>", "text/html").request("/x");
			expect(res.headers.get("content-type")).toBe("text/html");
			expect(await res.text()).toBe("<h1>Hi</h1>");
		});
	});
});
