/**
 * The auth nodes (#1018) — `currentUser`, `register`, `login`, `logout`,
 * `forgotPassword`, `resetPassword`.
 *
 * Canonical `use:` refs are `@blokjs/auth.<op>`. Register them in the app's
 * `Nodes.ts`:
 *
 * ```ts
 * import { AUTH_NODES } from "@blokjs/auth";
 * import { SESSION_NODES } from "@blokjs/session";
 * export default { ...SESSION_NODES, ...AUTH_NODES };
 * ```
 *
 * Every write node returns a `RespondEnvelope`, so a workflow step IS the
 * response: a 303 on success, `redirectBack()` with `props.errors` on failure.
 * None of them logs a password, hash, session id or reset token — the inputs
 * these nodes accept are `email`/`password` and the only thing that reaches a
 * trace is the envelope.
 */

import { defineNode } from "@blokjs/core";
import { flashCookie, logoutResponse, redirect, redirectBack, rotateCsrf } from "@blokjs/inertia";
import { destroySession, loadSession, startSession } from "@blokjs/session";
import { RESPOND_BRAND, type RespondEnvelope } from "@blokjs/shared";
import { z } from "zod";
import { authOptions, getUserStore } from "./config.js";
import { decoyHash, hashPassword, verifyPassword } from "./password.js";
import { clearThrottle, hitThrottle, throttleKey } from "./throttle.js";
import { consumeResetToken, createResetToken } from "./tokens.js";
import { DuplicateEmailError, normalizeEmail } from "./user-store.js";

/** The `ctx.request` slice these nodes read. */
interface AuthRequest {
	headers?: Record<string, unknown>;
	method?: string;
}

function requestOf(ctx: unknown): AuthRequest {
	const request = (ctx as { request?: AuthRequest } | undefined)?.request;
	return { headers: request?.headers, method: request?.method };
}

/**
 * A 303 redirect. `redirect()` promotes PUT/PATCH/DELETE on its own; a POST
 * gets the same treatment here because every caller below answers a WRITE, and
 * a 302 invites the browser to replay it.
 */
function seeOther(target: string, method: string | undefined, cookies: string[]): RespondEnvelope {
	const env = redirect(target, { method });
	const status = env.status === 302 ? 303 : env.status;
	return { ...env, status, cookies: [...(env.cookies ?? []), ...cookies] };
}

/** The `RespondEnvelope` output schema every write node shares. */
const envelopeSchema = z.object({
	[RESPOND_BRAND]: z.literal(true),
	body: z.unknown().optional(),
	status: z.number().optional(),
	contentType: z.string().optional(),
	headers: z.record(z.string()).optional(),
	cookies: z.array(z.string()).optional(),
});

/** The body a form posts. `unknown` per field — `@blokjs/validate` already checked it. */
const bodySchema = z
	.record(z.unknown())
	.optional()
	.describe("The validated request body (the `data` output of the @blokjs/validate step).");

// =============================================================================
// currentUser
// =============================================================================

const publicUser = z.object({ id: z.string(), name: z.string(), email: z.string() });

/**
 * `currentUser` — who is signed in, for `inertia.shared`'s `auth` step.
 *
 * The output carries BOTH shapes on purpose:
 *
 * - `id` is what `inertia.auth`'s guest guard tests (`!ctx.state.auth?.id`),
 * - `user` is what the client reads (`usePage().props.auth.user`), and is
 *   `null` for a guest so a page can branch on it without optional chaining.
 *
 * The password hash is never in either.
 */
export const currentUserNode = defineNode({
	name: "@blokjs/auth.currentUser",
	description: "Resolve the signed-in user from the session. Shape: { id?, user } — no password hash.",
	input: z.object({
		headers: z.record(z.unknown()).optional().describe("Request headers. Supplied by inertia.shared; unused here."),
	}),
	output: z.object({
		id: z.string().optional().describe("The signed-in user's id. ABSENT for a guest — inertia.auth gates on it."),
		user: publicUser.nullable().describe("The signed-in user as the client sees them, or null."),
	}),

	async execute(ctx) {
		// `loadSession` memoises on `ctx.request`, so the middleware chain and
		// the page's own `auth` prop share one store read.
		const session = await loadSession(ctx);
		const userId = session.data.userId;
		if (typeof userId !== "string") return { user: null };
		const user = await getUserStore().findById(userId);
		// A session pointing at a deleted user is a guest, not a 500.
		if (!user) return { user: null };
		return { id: user.id, user: { id: user.id, name: user.name, email: user.email } };
	},
});

// =============================================================================
// register
// =============================================================================

export const registerNode = defineNode({
	name: "@blokjs/auth.register",
	description: "Create an account, sign it in on a fresh session, and redirect (303).",
	input: z.object({ body: bodySchema }),
	output: envelopeSchema,

	async execute(ctx, input): Promise<RespondEnvelope> {
		const req = requestOf(ctx);
		const body = (input.body ?? {}) as Record<string, unknown>;
		const email = normalizeEmail(String(body.email ?? ""));
		const name = String(body.name ?? "").trim();
		const password = String(body.password ?? "");

		if (await getUserStore().findByEmail(email)) {
			return redirectBack(req, {
				errors: { email: "That email address is already registered." },
				fallback: "/register",
			});
		}

		let user: { id: string };
		try {
			user = await getUserStore().create({ name, email, passwordHash: await hashPassword(password) });
		} catch (error) {
			// The UNIQUE index caught a concurrent signup for the same address.
			if (error instanceof DuplicateEmailError) {
				return redirectBack(req, {
					errors: { email: "That email address is already registered." },
					fallback: "/register",
				});
			}
			throw error;
		}

		const { cookie } = await startSession(ctx, { userId: user.id });
		// A new principal gets a new CSRF token: a token fixed before signup
		// must not stay valid afterwards.
		rotateCsrf(ctx);
		return seeOther(authOptions().redirectAfterLogin, req.method, [cookie]);
	},
});

// =============================================================================
// login
// =============================================================================

export const loginNode = defineNode({
	name: "@blokjs/auth.login",
	description: "Verify credentials (throttled per IP+email), start a fresh session, and redirect (303).",
	input: z.object({ body: bodySchema }),
	output: envelopeSchema,

	async execute(ctx, input): Promise<RespondEnvelope> {
		const req = requestOf(ctx);
		const opts = authOptions();
		const body = (input.body ?? {}) as Record<string, unknown>;
		const email = normalizeEmail(String(body.email ?? ""));
		const password = String(body.password ?? "");
		const key = throttleKey(req.headers, email, { trustProxy: opts.trustProxy });

		// Counted BEFORE the hash: a throttled attempt must not cost a scrypt.
		const verdict = await hitThrottle(key, { limit: opts.throttleLimit, windowSeconds: opts.throttleWindow });
		if (!verdict.allowed) {
			const message = `Too many login attempts. Please try again in ${verdict.retryAfter} seconds.`;
			return redirectBack(req, {
				errors: { email: message },
				flash: { error: message },
				fallback: "/login",
				headers: { "Retry-After": String(verdict.retryAfter) },
			});
		}

		const user = await getUserStore().findByEmail(email);
		// Verify against a decoy when the address is unknown, so a miss costs the
		// same wall-clock time as a hit and the form cannot enumerate accounts.
		const ok = await verifyPassword(password, user?.passwordHash ?? (await decoyHash()));
		if (!user || !ok) {
			// Deliberately one message for both cases, on the `email` field —
			// which is where the client renders it (`props.errors.email`).
			return redirectBack(req, {
				errors: { email: "These credentials do not match our records." },
				fallback: "/login",
			});
		}

		await clearThrottle(key);
		// "Remember me", for real (#1018 security review M2): ticked keeps the
		// cookie for the session TTL, unticked makes it a BROWSER-SESSION cookie
		// that dies with the window. The checkbox was on the form and in the
		// schema before this; nothing read it.
		const remember = body.remember === true || body.remember === "true" || body.remember === "on";
		const { cookie } = await startSession(ctx, { userId: user.id }, { persistent: remember });
		rotateCsrf(ctx);
		return seeOther(opts.redirectAfterLogin, req.method, [cookie]);
	},
});

// =============================================================================
// logout
// =============================================================================

export const logoutNode = defineNode({
	name: "@blokjs/auth.logout",
	description: "Destroy the session, clear the browser history, rotate the CSRF token, and redirect (303).",
	input: z.object({
		redirectTo: z
			.string()
			.optional()
			.describe("Where to land afterwards. Default: configureAuth's redirectAfterLogout."),
	}),
	output: envelopeSchema,

	async execute(ctx, input): Promise<RespondEnvelope> {
		const clearing = await destroySession(ctx);
		rotateCsrf(ctx);
		// `logoutResponse` (#1013) is the 303 + the `clearHistory` mark, and it
		// flashes the mark forward so the page AFTER the redirect is the one that
		// rotates the client's history key.
		const env = logoutResponse(ctx, { redirectTo: input.redirectTo ?? authOptions().redirectAfterLogout });
		return { ...env, cookies: [...(env.cookies ?? []), clearing] };
	},
});

// =============================================================================
// forgot password
// =============================================================================

export const forgotPasswordNode = defineNode({
	name: "@blokjs/auth.forgotPassword",
	description: "Issue a single-use password reset link and bounce back with a neutral status message.",
	input: z.object({ body: bodySchema }),
	output: envelopeSchema,

	async execute(ctx, input): Promise<RespondEnvelope> {
		const req = requestOf(ctx);
		const opts = authOptions();
		const email = normalizeEmail(String(((input.body ?? {}) as Record<string, unknown>).email ?? ""));
		const issued = await createResetToken(email);

		if (issued) {
			const url = opts.resetPath.replace(":token", encodeURIComponent(issued.token));
			if (opts.sendResetLink) await opts.sendResetLink({ email, token: issued.token, url });
			else logResetLink(ctx, email, url);
		}

		// The SAME answer whether or not the address exists. Anything else turns
		// this form into an account-enumeration oracle.
		return redirectBack(req, {
			flash: { status: "If that email address is registered, a password reset link is on its way." },
			fallback: "/forgot-password",
		});
	},
});

/**
 * No mailer configured: print the link, the way Laravel's `log` mail driver
 * does, so the flow is usable in dev. The TOKEN is in the URL and this is the
 * one place it is ever written down — `sendResetLink` replaces it in
 * production.
 */
function logResetLink(ctx: unknown, email: string, url: string): void {
	const logger = (ctx as { logger?: { logLevel?: (level: string, message: string) => void } } | undefined)?.logger;
	const message = `[blok] @blokjs/auth: no sendResetLink configured — password reset link for ${email}: ${url} (configureAuth({ sendResetLink }) to send it for real).`;
	if (typeof logger?.logLevel === "function") logger.logLevel("warn", message);
	else console.warn(message);
}

// =============================================================================
// reset password
// =============================================================================

export const resetPasswordNode = defineNode({
	name: "@blokjs/auth.resetPassword",
	description: "Spend a reset token (single-use, expiring) and set the new password.",
	input: z.object({
		body: bodySchema,
		token: z
			.string()
			.optional()
			.describe("The raw token. Defaults to `body.token` — pass req.params.token for a path token."),
	}),
	output: envelopeSchema,

	async execute(ctx, input): Promise<RespondEnvelope> {
		const req = requestOf(ctx);
		const body = (input.body ?? {}) as Record<string, unknown>;
		const token = input.token ?? String(body.token ?? "");
		const userId = await consumeResetToken(token);

		if (!userId) {
			// Unknown, already spent, or expired — one message for all three.
			return redirectBack(req, {
				errors: { email: "This password reset link is invalid or has expired." },
				fallback: "/forgot-password",
			});
		}

		// The link proves control of the mailbox, but the form still names an
		// address: refuse a token that does not belong to it rather than
		// resetting a different account's password.
		const user = await getUserStore().findById(userId);
		const claimed = normalizeEmail(String(body.email ?? ""));
		if (!user || (claimed.length > 0 && user.email !== claimed)) {
			return redirectBack(req, {
				errors: { email: "This password reset link is invalid or has expired." },
				fallback: "/forgot-password",
			});
		}

		await getUserStore().updatePassword(user.id, await hashPassword(String(body.password ?? "")));
		// Every existing session for this account should die with the old
		// password, but the store is keyed by session id, not user — so at
		// minimum end THIS one and make the user sign in with the new password.
		await destroySession(ctx);
		rotateCsrf(ctx);
		const status = flashCookie({ flash: { status: "Your password has been reset. Please sign in." } });
		return seeOther(authOptions().redirectAfterLogout, req.method, status ? [status] : []);
	},
});

// =============================================================================
// form plumbing
// =============================================================================

/**
 * `bounce` — redirect back carrying validation errors.
 *
 * The failure arm of every form workflow: `@blokjs/validate` returns the errors
 * as DATA rather than throwing (#1011), and this turns them into the 303 the
 * client follows, with the errors in the signed flash cookie that
 * `inertia.shared` reads back as `props.errors`.
 */
export const bounceNode = defineNode({
	name: "@blokjs/auth.bounce",
	description: "Redirect back to the referring page with validation errors in the one-shot flash cookie.",
	input: z.object({
		errors: z.record(z.unknown()).optional().describe("Dot-path keyed messages, e.g. @blokjs/validate's `errors`."),
		flash: z.record(z.unknown()).optional().describe("Page-object flash data to carry across the redirect."),
		fallback: z.string().optional().describe("Where to go when the request carried no Referer. Default '/'."),
	}),
	output: envelopeSchema,

	async execute(ctx, input): Promise<RespondEnvelope> {
		return redirectBack(requestOf(ctx), {
			errors: input.errors as Record<string, unknown> | undefined,
			flash: input.flash as Record<string, unknown> | undefined,
			...(input.fallback !== undefined ? { fallback: input.fallback } : {}),
		});
	},
});

/**
 * `resetToken` — put the URL's `:token` on the reset page as a prop.
 *
 * A page prop has to come from a node, and the reset form needs the token to
 * post it back. Nothing is looked up here: the token is only ever CHECKED when
 * it is spent, by {@link resetPasswordNode}.
 */
export const resetTokenNode = defineNode({
	name: "@blokjs/auth.resetToken",
	description: "Echo the reset token (and email) from the URL onto the reset-password page as a prop.",
	input: z.object({
		token: z.string().optional().describe("Usually req.params.token."),
		email: z.string().optional().describe("Usually req.query.email — prefills the form."),
	}),
	output: z.object({ token: z.string(), email: z.string().optional() }),

	async execute(_ctx, input) {
		return { token: input.token ?? "", ...(input.email !== undefined ? { email: input.email } : {}) };
	},
});

/** Every auth node, keyed by its canonical `use:` ref — spread into `Nodes.ts`. */
export const AUTH_NODES = {
	"@blokjs/auth.currentUser": currentUserNode,
	"@blokjs/auth.register": registerNode,
	"@blokjs/auth.login": loginNode,
	"@blokjs/auth.logout": logoutNode,
	"@blokjs/auth.forgotPassword": forgotPasswordNode,
	"@blokjs/auth.resetPassword": resetPasswordNode,
	"@blokjs/auth.bounce": bounceNode,
	"@blokjs/auth.resetToken": resetTokenNode,
} as const;
