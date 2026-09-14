/**
 * The kit's workflows (#1018) — the eleven routes a Laravel starter kit ships,
 * written in the typed-handle DSL.
 *
 * They are REAL workflows, not pseudo-code: the integration tests register this
 * exact map through a live `HttpTrigger`, and `blokctl add spa --kit auth`
 * (#999) copies them into a project. Read them as the reference for wiring a
 * form in Blok:
 *
 * 1. `@blokjs/validate` checks the body and returns `{ ok, data, errors }` —
 *    it never throws, because a form failure is data.
 * 2. `branch()` on `checked.ok` splits the success and failure arms.
 * 3. The failure arm bounces back with the errors; the success arm runs the
 *    auth node, which answers with a 303.
 * 4. GET routes are one `page` control step via `definePage().render()`.
 *
 * ```ts
 * // src/Workflows.ts
 * import { AUTH_KIT_CHAIN, authKitMiddleware, authWorkflows } from "@blokjs/auth/examples";
 * export default { ...(await authKitMiddleware()), ...(await authWorkflows()) };
 * setGlobalMiddleware([...AUTH_KIT_CHAIN]);
 * ```
 */

import { http, type Handle, branch, node, step, tpl, workflow } from "@blokjs/core";
import { AUTH_GUARD } from "../middleware.js";
import { bounceNode, forgotPasswordNode, loginNode, logoutNode, registerNode, resetPasswordNode } from "../nodes.js";
import { ForgotPasswordSchema, LoginSchema, RegisterSchema, ResetPasswordSchema } from "../schemas.js";
import { DashboardPage, ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage } from "./pages.js";

/** `@blokjs/validate` by ref — it lives in `@blokjs/helpers`, which every Blok app already has. */
const validate = node<{ ok: boolean; data: Record<string, unknown>; errors: Record<string, unknown> }>(
	"@blokjs/validate",
);

/** The HTTP entry handle, named for the two fields these workflows read. */
type Req = Handle<{ body: unknown; params: Record<string, string>; query: Record<string, string> }>;

const VERSION = "1.0.0";

// =============================================================================
// GET pages
// =============================================================================

/** `GET /login`. */
export const loginPageWorkflow = () =>
	workflow("auth.loginPage", { version: VERSION, trigger: http.get("/login") }, (req) => {
		LoginPage.render(req, "page", "/login", {});
	});

/** `GET /register`. */
export const registerPageWorkflow = () =>
	workflow("auth.registerPage", { version: VERSION, trigger: http.get("/register") }, (req) => {
		RegisterPage.render(req, "page", "/register", {});
	});

/** `GET /forgot-password`. */
export const forgotPasswordPageWorkflow = () =>
	workflow("auth.forgotPasswordPage", { version: VERSION, trigger: http.get("/forgot-password") }, (req) => {
		ForgotPasswordPage.render(req, "page", "/forgot-password", {});
	});

/** `GET /reset-password/:token` — the token rides the URL onto the page as a prop. */
export const resetPasswordPageWorkflow = () =>
	workflow("auth.resetPasswordPage", { version: VERSION, trigger: http.get("/reset-password/:token") }, (entry) => {
		const req = entry as unknown as Req;
		// ponytail: `render()`'s `url` is typed `string | Handle<string>`, and
		// `tpl` returns the structural `$tpl` shape — which the page step passes
		// through to the serializer as an ordinary input, so the MAPPER resolves
		// it at run time exactly like any other embedded handle. The cast names
		// the type-surface gap rather than hiding it; widening `render()` to
		// accept a `tpl` belongs in `@blokjs/inertia`.
		const url = tpl`/reset-password/${req.params.token}` as unknown as Handle<string>;
		ResetPasswordPage.render(req, "page", url, {
			reset: { token: req.params.token, email: req.query.email },
		});
	});

/** `GET /dashboard` — guarded: a guest is redirected by `inertia.auth` before any step runs. */
export const dashboardWorkflow = () =>
	workflow(
		"auth.dashboard",
		{ version: VERSION, trigger: http.get("/dashboard", { middleware: [AUTH_GUARD] }) },
		(req) => {
			DashboardPage.render(req, "page", "/dashboard", {});
		},
	);

// =============================================================================
// POST forms
// =============================================================================

/** `POST /login`. */
export const loginWorkflow = () =>
	workflow("auth.login", { version: VERSION, trigger: http.post("/login") }, (entry) => {
		const req = entry as unknown as Req;
		const checked = step("validateLogin", validate, { schema: LoginSchema, data: req.body });
		branch("loginGate", checked.ok, {
			then: () => {
				step("login", loginNode, { body: checked.data });
			},
			else: () => {
				step("loginErrors", bounceNode, { errors: checked.errors, fallback: "/login" });
			},
		});
	});

/** `POST /register`. */
export const registerWorkflow = () =>
	workflow("auth.register", { version: VERSION, trigger: http.post("/register") }, (entry) => {
		const req = entry as unknown as Req;
		const checked = step("validateRegister", validate, { schema: RegisterSchema, data: req.body });
		branch("registerGate", checked.ok, {
			then: () => {
				step("register", registerNode, { body: checked.data });
			},
			else: () => {
				step("registerErrors", bounceNode, { errors: checked.errors, fallback: "/register" });
			},
		});
	});

/** `POST /logout` — destroys the session, clears client history, rotates the CSRF token. */
export const logoutWorkflow = () =>
	workflow("auth.logout", { version: VERSION, trigger: http.post("/logout") }, () => {
		step("logout", logoutNode, {});
	});

/** `POST /forgot-password`. */
export const forgotPasswordWorkflow = () =>
	workflow("auth.forgotPassword", { version: VERSION, trigger: http.post("/forgot-password") }, (entry) => {
		const req = entry as unknown as Req;
		const checked = step("validateForgot", validate, { schema: ForgotPasswordSchema, data: req.body });
		branch("forgotGate", checked.ok, {
			then: () => {
				step("forgot", forgotPasswordNode, { body: checked.data });
			},
			else: () => {
				step("forgotErrors", bounceNode, { errors: checked.errors, fallback: "/forgot-password" });
			},
		});
	});

/**
 * `POST /reset-password/:token`.
 *
 * The token is validated as part of the body (the form posts it back), and the
 * path param is passed to the node as the authoritative copy — a form field
 * cannot point the reset at another link.
 */
export const resetPasswordWorkflow = () =>
	workflow("auth.resetPassword", { version: VERSION, trigger: http.post("/reset-password/:token") }, (entry) => {
		const req = entry as unknown as Req;
		const checked = step("validateReset", validate, { schema: ResetPasswordSchema, data: req.body });
		branch("resetGate", checked.ok, {
			then: () => {
				step("reset", resetPasswordNode, { body: checked.data, token: req.params.token });
			},
			else: () => {
				step("resetErrors", bounceNode, { errors: checked.errors, fallback: "/forgot-password" });
			},
		});
	});

// =============================================================================
// The map
// =============================================================================

/**
 * Every workflow the kit ships, keyed the way `src/Workflows.ts` expects.
 *
 * A function rather than a top-level `await` so importing the module costs
 * nothing until an app actually registers the routes.
 */
export async function authWorkflows(): Promise<Record<string, unknown>> {
	return {
		"auth.loginPage": await loginPageWorkflow(),
		"auth.login": await loginWorkflow(),
		"auth.logout": await logoutWorkflow(),
		"auth.registerPage": await registerPageWorkflow(),
		"auth.register": await registerWorkflow(),
		"auth.forgotPasswordPage": await forgotPasswordPageWorkflow(),
		"auth.forgotPassword": await forgotPasswordWorkflow(),
		"auth.resetPasswordPage": await resetPasswordPageWorkflow(),
		"auth.resetPassword": await resetPasswordWorkflow(),
		"auth.dashboard": await dashboardWorkflow(),
	};
}
