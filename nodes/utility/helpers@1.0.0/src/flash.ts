import { defineNode } from "@blokjs/runner";
import {
	FLASH_COOKIE,
	type FlashPayload,
	clearFlashCookie,
	flashSetCookie,
	readCookie,
	resolveFlashSecret,
	signFlash,
	verifyFlash,
} from "@blokjs/shared";
import { z } from "zod";

/**
 * Signed, one-shot flash cookie (#996) — the server side of Inertia's
 * "redirect back with errors" flow.
 *
 * - `op: "write"` signs `{ errors, bag, flash, preserveFragment }` (or an
 *   arbitrary `value`) into a `Set-Cookie` string the caller attaches to a
 *   redirect response.
 * - `op: "read"` verifies the cookie off the request's `Cookie` header and
 *   returns the payload PLUS the clearing `Set-Cookie` — one-shot means the
 *   response that consumes the flash must also expire it.
 *
 * Tampering, a wrong secret or a malformed cookie all read back as "no flash"
 * (`present: false`, empty `errors`/`flash`); the node never throws on bad
 * INPUT. It DOES throw when no signing secret is configured — see
 * `resolveFlashSecret`: an unsigned flash cookie is a forgeable one, so
 * `BLOK_FLASH_SECRET` is required rather than defaulted.
 *
 * The crypto itself lives in `@blokjs/shared` so `@blokjs/inertia`'s
 * `redirectBack()` signs byte-identical cookies without either package
 * importing the other.
 */
export default defineNode({
	name: "@blokjs/flash",
	description:
		"Read or write the signed one-shot flash cookie (HMAC-SHA256) that carries validation errors and flash data across a redirect.",
	input: z.object({
		op: z.enum(["read", "write"]).describe("`write` signs a Set-Cookie; `read` verifies + clears one."),
		cookieHeader: z
			.string()
			.optional()
			.describe("read: the raw `Cookie` request header, e.g. `ctx.request.headers.cookie`."),
		errors: z.record(z.unknown()).optional().describe("write: validation errors to carry across the redirect."),
		bag: z.string().optional().describe("write: error-bag name the errors nest under on the next render."),
		flash: z.record(z.unknown()).optional().describe("write: page-object flash data to carry across the redirect."),
		preserveFragment: z.boolean().optional().describe("write: keep the URL fragment across the redirect."),
		clearHistory: z
			.boolean()
			.optional()
			.describe("write: make the page after the redirect carry clearHistory (#1013 logout)."),
		value: z
			.record(z.unknown())
			.optional()
			.describe("write: the whole payload at once. Merged UNDER the explicit errors/bag/flash fields."),
		name: z.string().optional().describe(`Cookie name. Default '${FLASH_COOKIE}'.`),
		secret: z.string().optional().describe("Signing secret. Defaults to the BLOK_FLASH_SECRET env var."),
		maxAge: z.number().int().positive().optional().describe("write: cookie Max-Age in seconds. Default 120."),
		path: z.string().optional().describe("Cookie Path. Default '/'."),
		sameSite: z.enum(["Lax", "Strict", "None"]).optional().describe("Cookie SameSite. Default 'Lax'."),
		secure: z.boolean().optional().describe("Add the Secure attribute (HTTPS-only cookie)."),
	}),
	output: z.object({
		cookie: z.string().describe("The Set-Cookie value to emit — the signed cookie on write, the clearing one on read."),
		present: z.boolean().describe("read: true when a valid, correctly-signed payload was found."),
		errors: z.record(z.unknown()).describe("read: the payload's errors, {} when absent."),
		bag: z.string().optional().describe("read: the payload's error-bag name."),
		flash: z.record(z.unknown()).describe("read: the payload's flash data, {} when absent."),
		preserveFragment: z.boolean().describe("read: the payload's preserveFragment flag."),
		clearHistory: z
			.boolean()
			.optional()
			.describe(
				"read: true when the payload carried clearHistory, UNDEFINED otherwise — never false, so feeding it " +
					"to the adapter's `clearHistory` input cannot override a mark set in this same request.",
			),
		value: z.record(z.unknown()).optional().describe("read: the whole verified payload, undefined when absent."),
	}),

	async execute(_ctx, input) {
		const secret = resolveFlashSecret(input.secret);
		const cookieOpts = {
			name: input.name ?? FLASH_COOKIE,
			path: input.path,
			sameSite: input.sameSite,
			secure: input.secure,
		};

		if (input.op === "write") {
			const payload: FlashPayload = {
				...(input.value as FlashPayload | undefined),
				...(input.errors !== undefined ? { errors: input.errors } : {}),
				...(input.bag !== undefined ? { bag: input.bag } : {}),
				...(input.flash !== undefined ? { flash: input.flash } : {}),
				...(input.preserveFragment !== undefined ? { preserveFragment: input.preserveFragment } : {}),
				...(input.clearHistory !== undefined ? { clearHistory: input.clearHistory } : {}),
			};
			return {
				cookie: flashSetCookie(signFlash(payload, secret), { ...cookieOpts, maxAge: input.maxAge }),
				present: true,
				errors: payload.errors ?? {},
				bag: payload.bag,
				flash: payload.flash ?? {},
				preserveFragment: payload.preserveFragment === true,
				clearHistory: payload.clearHistory === true ? true : undefined,
				value: payload as Record<string, unknown>,
			};
		}

		const payload = verifyFlash(readCookie(input.cookieHeader, cookieOpts.name), secret);
		return {
			// Always emit the clearing cookie: one-shot semantics mean the
			// response that read the flash is the one that expires it, and
			// clearing an absent cookie is a no-op for the browser.
			cookie: clearFlashCookie(cookieOpts),
			present: payload !== undefined,
			errors: payload?.errors ?? {},
			bag: payload?.bag,
			flash: payload?.flash ?? {},
			preserveFragment: payload?.preserveFragment === true,
			// `true` or ABSENT, never `false` — see the schema note.
			clearHistory: payload?.clearHistory === true ? true : undefined,
			value: payload as Record<string, unknown> | undefined,
		};
	},
});
