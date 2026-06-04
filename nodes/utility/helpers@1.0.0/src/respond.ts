import { defineNode } from "@blokjs/runner";
import { RESPOND_BRAND } from "@blokjs/shared";
import { z } from "zod";

/**
 * v0.6.14 — shape the full HTTP response from a workflow. Use as the FINAL
 * step of an `http`-triggered workflow to control status, headers, cookies,
 * Content-Type, and body (incl. raw binary) — beyond the default JSON/string-200.
 *
 * Returns a branded envelope the `http` trigger recognizes and unpacks. A
 * stateless mapper — it does not touch `ctx`, so it's safe anywhere (under a
 * non-HTTP trigger the envelope is just inert data).
 *
 * @example  // redirect
 *   { id: "go", use: "@blokjs/respond",
 *     inputs: { status: 302, headers: { Location: "/dashboard" } } }
 *
 * @example  // session cookie + JSON body
 *   { id: "login", use: "@blokjs/respond",
 *     inputs: { body: { ok: true },
 *               cookies: ["session=abc; Path=/; HttpOnly; SameSite=Lax"] } }
 *
 * @example  // binary download
 *   { id: "file", use: "@blokjs/respond",
 *     inputs: { body: "js/ctx.state.pdf.bytes", contentType: "application/pdf",
 *               headers: { "Content-Disposition": "attachment; filename=\"report.pdf\"" } } }
 */
export default defineNode({
	name: "@blokjs/respond",
	description:
		"Shape the full HTTP response (status, headers, Set-Cookie, Content-Type, body incl. binary). Final step of an http workflow.",
	input: z.object({
		body: z
			.unknown()
			.optional()
			.describe(
				"Response body. string → verbatim; Uint8Array/Buffer/ArrayBuffer → raw bytes; else → JSON. Omit for empty.",
			),
		status: z.number().int().min(100).max(599).optional().describe("HTTP status code. Defaults to 200."),
		contentType: z
			.string()
			.optional()
			.describe("Content-Type override. Defaults to application/json (object) or application/octet-stream (binary)."),
		headers: z
			.record(z.string())
			.optional()
			.describe("Response headers, e.g. { Location } for redirects or { 'Content-Disposition' } for downloads."),
		cookies: z
			.array(z.string())
			.optional()
			.describe("Raw Set-Cookie values; each becomes its own Set-Cookie header (the header may repeat)."),
	}),
	output: z.object({
		[RESPOND_BRAND]: z.literal(true),
		body: z.unknown().optional(),
		status: z.number().optional(),
		contentType: z.string().optional(),
		headers: z.record(z.string()).optional(),
		cookies: z.array(z.string()).optional(),
	}),
	async execute(_ctx, input) {
		return {
			[RESPOND_BRAND]: true as const,
			body: input.body,
			status: input.status,
			contentType: input.contentType,
			headers: input.headers,
			cookies: input.cookies,
		};
	},
});
