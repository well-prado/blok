import { defineNode } from "@blokjs/runner";
import {
	CSRF_COOKIE,
	CSRF_EXPIRED_MESSAGE,
	CSRF_FIELD,
	CSRF_HEADER,
	GlobalError,
	csrfPathExempt,
	csrfSecureFor,
	csrfSetCookie,
	csrfTokensMatch,
	flashSetCookie,
	issueCsrfCookie,
	markCsrfToken,
	newCsrfToken,
	pendingCsrfCookies,
	readCookie,
	resolveFlashSecret,
	signFlash,
} from "@blokjs/shared";
import { z } from "zod";

/** Methods whose token is verified. Everything else only ever ISSUES a cookie. */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The `ctx.request` slice this node reads (see the node-side ctx ABI in CLAUDE.md). */
interface CsrfRequest {
	headers?: Record<string, unknown>;
	body?: unknown;
	method?: unknown;
	originalMethod?: unknown;
	path?: unknown;
	url?: unknown;
}

function requestOf(ctx: unknown): CsrfRequest {
	return ((ctx as { request?: CsrfRequest } | undefined)?.request ?? {}) as CsrfRequest;
}

/** A header value as a string — repeated headers arrive joined, never as arrays. */
function headerValue(headers: Record<string, unknown>, name: string): string | undefined {
	const value = headers[name.toLowerCase()];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Double-submit CSRF guard (#1012) — the node `inertia.csrf` runs.
 *
 * It does three things, in this order:
 *
 * 1. **Issue.** No `XSRF-TOKEN` cookie on the request → mint 32 random bytes
 *    and put the `Set-Cookie` on whatever response this request produces
 *    (`issueCsrfCookie`, which hangs an accessor on `ctx.response` — the
 *    middleware runs long before any response exists, and must not depend on
 *    the Inertia serializer being the thing that answers).
 * 2. **Verify.** On POST/PUT/PATCH/DELETE, compare the `X-XSRF-TOKEN` header
 *    — or the legacy `_token` body field — against the cookie, in constant
 *    time.
 * 3. **Reject.** A mismatch does NOT return a bare `419`: an Inertia visit
 *    that gets one has nothing to render and the client shows its error modal.
 *    The default is a redirect BACK with the expiry message in the signed
 *    flash cookie (#996), which is an ordinary visit the client follows and
 *    the next page renders as a toast. `onMismatch: "419"` opts an API-style
 *    route into the raw status instead.
 *
 * The token is not a credential — it authenticates nothing, it only has to be
 * unguessable and unreadable across origins, which is why the cookie is
 * deliberately not `HttpOnly` (the client has to echo it back).
 */
export default defineNode({
	name: "@blokjs/csrf",
	description:
		"Double-submit CSRF guard: issue the XSRF-TOKEN cookie, verify the X-XSRF-TOKEN header (or _token field) on writes, and bounce a mismatch back with a flash message.",
	input: z.object({
		cookieName: z.string().min(1).optional().describe(`Cookie name. Default '${CSRF_COOKIE}'.`),
		headerName: z.string().min(1).optional().describe(`Header name. Default '${CSRF_HEADER}'.`),
		field: z
			.string()
			.min(1)
			.optional()
			.describe(`Legacy body field accepted instead of the header. Default '${CSRF_FIELD}'.`),
		except: z
			.array(z.string())
			.optional()
			.describe("Path globs exempt from verification, e.g. ['webhooks/*']. '*' matches across slashes."),
		apiExempt: z
			.boolean()
			.optional()
			.describe("true exempts NON-Inertia requests (no X-Inertia header) — opt-in, off by default."),
		onMismatch: z
			.enum(["redirect", "419"])
			.optional()
			.describe("'redirect' (default) bounces back with the expiry flash; '419' returns a raw 419 JSON body."),
		fallback: z.string().optional().describe("Redirect target when the request carried no Referer. Default '/'."),
		message: z.string().optional().describe(`Flash/error message. Default '${CSRF_EXPIRED_MESSAGE}'.`),
		path: z.string().optional().describe("Cookie Path. Default '/'."),
		sameSite: z.enum(["Lax", "Strict", "None"]).optional().describe("Cookie SameSite. Default 'Lax'."),
		maxAge: z.number().int().positive().optional().describe("Cookie Max-Age in seconds. Default: a session cookie."),
		secure: z
			.boolean()
			.optional()
			.describe("Force the Secure attribute. Default: set when the request arrived over HTTPS."),
		secret: z.string().optional().describe("Flash signing secret for the bounce-back. Defaults to BLOK_FLASH_SECRET."),
	}),
	output: z.object({
		issued: z.boolean().describe("true when this request had no token cookie and a fresh one was issued."),
		verified: z.boolean().describe("true when a write request's token was checked AND matched."),
		exempt: z.boolean().describe("true when verification was skipped (safe method, glob exemption, or apiExempt)."),
	}),

	async execute(ctx, input) {
		const request = requestOf(ctx);
		const headers = (request.headers ?? {}) as Record<string, unknown>;
		const cookieName = input.cookieName ?? CSRF_COOKIE;
		const cookieOpts = {
			name: cookieName,
			path: input.path,
			sameSite: input.sameSite,
			maxAge: input.maxAge,
			secure: input.secure ?? csrfSecureFor(request),
		};

		// --- 1. issue ---------------------------------------------------------
		const existing = readCookie(headerValue(headers, "cookie"), cookieName);
		const issued = existing === undefined;
		const token = existing ?? newCsrfToken();
		if (issued) issueCsrfCookie(ctx, csrfSetCookie(token, cookieOpts));
		// So `share("csrfToken", …)` can put THIS request's token on the page
		// even when the browser is only now being told about it.
		markCsrfToken(request, token);

		// --- 2. should this request be verified at all? -----------------------
		const method = String(request.method ?? "GET").toUpperCase();
		// `_method` spoofing (#1016) only ever turns a POST into another write,
		// so either spelling being a write is enough — and neither can be relied
		// on alone.
		const original = String(request.originalMethod ?? method).toUpperCase();
		const isWrite = WRITE_METHODS.has(method) || WRITE_METHODS.has(original);
		const path = typeof request.path === "string" ? request.path : "/";
		const inertia = headerValue(headers, "x-inertia") === "true";
		const exempt = !isWrite || csrfPathExempt(path, input.except) || (input.apiExempt === true && !inertia);
		if (exempt) return { issued, verified: false, exempt: true };

		// --- 3. verify --------------------------------------------------------
		const body = request.body;
		const field = input.field ?? CSRF_FIELD;
		const fromBody = body !== null && typeof body === "object" ? (body as Record<string, unknown>)[field] : undefined;
		const submitted =
			headerValue(headers, input.headerName ?? CSRF_HEADER) ?? (typeof fromBody === "string" ? fromBody : undefined);

		if (csrfTokensMatch(existing, submitted)) {
			return { issued, verified: true, exempt: false };
		}

		// --- 4. reject --------------------------------------------------------
		const message = input.message ?? CSRF_EXPIRED_MESSAGE;
		const error = new GlobalError(message);
		error.setName("CsrfTokenMismatch");
		// The cookie this request issued has to ride the REJECTION too: a throw
		// never reaches `ctx.response`, and without it the retry would arrive
		// with no token either and fail again, forever.
		const cookies = pendingCsrfCookies(ctx);

		if (input.onMismatch === "419") {
			error.setCode(419);
			error.setJson({ error: message, code: "csrf_token_mismatch" });
			if (cookies.length > 0) error.setCookies(cookies);
			throw error;
		}

		const target = headerValue(headers, "referer") ?? headerValue(headers, "referrer") ?? input.fallback ?? "/";
		// A rejected WRITE must come back as a GET — a 302 lets the browser (and
		// a non-Inertia client) replay the POST against the target.
		error.setCode(303);
		error.setHeaders({ Location: target });
		try {
			// The flash cookie keeps its OWN defaults (`Path=/`, HttpOnly): it is a
			// different cookie with a different audience, and narrowing it to the
			// token cookie's path would hide the message from the page we bounce to.
			cookies.push(flashSetCookie(signFlash({ flash: { message } }, resolveFlashSecret(input.secret))));
		} catch {
			// ponytail: no BLOK_FLASH_SECRET configured — the redirect still
			// protects the request, it just lands without the toast. Failing the
			// bounce-back closed would turn a missing env var into a wedged form.
		}
		if (cookies.length > 0) error.setCookies(cookies);
		throw error;
	},
});
