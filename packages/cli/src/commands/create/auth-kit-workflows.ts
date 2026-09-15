/**
 * The `--kit auth` route files (#1018), keyed by filename under
 * `src/workflows/auth/`.
 *
 * These are REAL workflows written into the project, not re-export shims
 * (#1018 security review M4). Two reasons, both load-bearing:
 *
 * 1. **They are the user's.** A starter kit that hands you ten files you cannot
 *    edit is a dependency wearing a costume. Change a redirect, add a field,
 *    drop a route — it is ordinary code in your repo.
 * 2. **`blokctl gen app-types` reads them.** Its `blok-app.d.ts` half parses a
 *    LITERAL `workflow("name", …)` statically; a file whose default export was
 *    `loginWorkflow()` got skipped, so all ten auth routes vanished from the
 *    typed client index with a "Skipped 10 file(s)" notice on every run.
 *
 * The nodes, schemas and prop contracts still come from `@blokjs/auth` — that is
 * the tested, updatable half. Only the wiring is copied.
 *
 * Each file declares its own `definePage()` where it renders one: the
 * generator's scan imports workflow modules, and a contract in a SHARED module
 * is seen on the first scan only (the module stays cached).
 *
 * THE TEXT BELOW IS BIOME-FORMATTED OUTPUT. The scaffold smoke runs
 * `biome check` over the generated `src/workflows/auth/`, so these strings must
 * be exactly what the formatter produces — import order included.
 */

export const AUTH_ROUTE_FILES: Record<string, string> = {
	"login-page.ts": `// \`GET /login\` — the sign-in page (blokctl add spa --kit auth).
//
// Yours to edit. The nodes and the prop contract come from \`@blokjs/auth\`;
// everything else on this page is ordinary Blok authoring.
// Errors from a failed sign-in arrive as \`props.errors.email\`.
import { currentUserNode } from "@blokjs/auth";
import { http, workflow } from "@blokjs/core";
import { always, definePage } from "@blokjs/inertia";

/** The page CONTRACT: every key is a prop, every value the node that produces it. */
export const LoginPage = definePage("Auth/Login", { auth: always(currentUserNode) });

export default workflow("auth.loginPage", { version: "1.0.0", trigger: http.get("/login") }, (req) => {
	LoginPage.render(req, "page", "/login", {});
});
`,
	"login.ts": `// \`POST /login\` — the sign-in form (blokctl add spa --kit auth).
//
// The shape every Blok form has:
//   1. \`@blokjs/validate\` checks the body and returns \`{ ok, data, errors }\` —
//      it never throws, because a form failure is data;
//   2. \`branch()\` on \`checked.ok\` splits success from failure;
//   3. the failure arm bounces back with the errors, the success arm runs the
//      auth node, which answers with a 303.
import { LoginSchema, bounceNode, loginNode } from "@blokjs/auth";
import { http, type Handle, branch, node, step, workflow } from "@blokjs/core";

/** \`@blokjs/validate\` by ref — it lives in \`@blokjs/helpers\`, which every Blok app has. */
const validate = node<{ ok: boolean; data: Record<string, unknown>; errors: Record<string, unknown> }>(
	"@blokjs/validate",
);

/** The HTTP entry handle, named for the fields this workflow reads. */
type Req = Handle<{ body: unknown; params: Record<string, string>; query: Record<string, string> }>;

export default workflow("auth.login", { version: "1.0.0", trigger: http.post("/login") }, (entry) => {
	const req = entry as unknown as Req;
	const checked = step("validate", validate, { schema: LoginSchema, data: req.body });
	branch("gate", checked.ok, {
		then: () => {
			step("login", loginNode, { body: checked.data });
		},
		else: () => {
			step("errors", bounceNode, { errors: checked.errors, fallback: "/login" });
		},
	});
});
`,
	"logout.ts": `// \`POST /logout\` — sign out (blokctl add spa --kit auth).
//
// One step, because the node does all three things that matter: destroy the
// session, mark the client's history for clearing, and rotate the CSRF token.
// It is a POST on purpose — a GET logout is CSRF-able and gets pre-fetched.
import { logoutNode } from "@blokjs/auth";
import { http, step, workflow } from "@blokjs/core";

export default workflow("auth.logout", { version: "1.0.0", trigger: http.post("/logout") }, () => {
	step("logout", logoutNode, {});
});
`,
	"register-page.ts": `// \`GET /register\` — the sign-up page (blokctl add spa --kit auth).
//
// Yours to edit. The nodes and the prop contract come from \`@blokjs/auth\`;
// everything else on this page is ordinary Blok authoring.
// The form's field names are \`RegisterSchema\`'s — rename one and the
// server's error keys stop matching.
import { currentUserNode } from "@blokjs/auth";
import { http, workflow } from "@blokjs/core";
import { always, definePage } from "@blokjs/inertia";

/** The page CONTRACT: every key is a prop, every value the node that produces it. */
export const RegisterPage = definePage("Auth/Register", { auth: always(currentUserNode) });

export default workflow("auth.registerPage", { version: "1.0.0", trigger: http.get("/register") }, (req) => {
	RegisterPage.render(req, "page", "/register", {});
});
`,
	"register.ts": `// \`POST /register\` — create an account (blokctl add spa --kit auth).
//
// The shape every Blok form has:
//   1. \`@blokjs/validate\` checks the body and returns \`{ ok, data, errors }\` —
//      it never throws, because a form failure is data;
//   2. \`branch()\` on \`checked.ok\` splits success from failure;
//   3. the failure arm bounces back with the errors, the success arm runs the
//      auth node, which answers with a 303.
import { RegisterSchema, bounceNode, registerNode } from "@blokjs/auth";
import { http, type Handle, branch, node, step, workflow } from "@blokjs/core";

/** \`@blokjs/validate\` by ref — it lives in \`@blokjs/helpers\`, which every Blok app has. */
const validate = node<{ ok: boolean; data: Record<string, unknown>; errors: Record<string, unknown> }>(
	"@blokjs/validate",
);

/** The HTTP entry handle, named for the fields this workflow reads. */
type Req = Handle<{ body: unknown; params: Record<string, string>; query: Record<string, string> }>;

export default workflow("auth.register", { version: "1.0.0", trigger: http.post("/register") }, (entry) => {
	const req = entry as unknown as Req;
	const checked = step("validate", validate, { schema: RegisterSchema, data: req.body });
	branch("gate", checked.ok, {
		then: () => {
			step("register", registerNode, { body: checked.data });
		},
		else: () => {
			step("errors", bounceNode, { errors: checked.errors, fallback: "/register" });
		},
	});
});
`,
	"forgot-password-page.ts": `// \`GET /forgot-password\` — ask for a reset link (blokctl add spa --kit auth).
//
// Yours to edit. The nodes and the prop contract come from \`@blokjs/auth\`;
// everything else on this page is ordinary Blok authoring.
// The outcome arrives as flash, never as a yes/no — the same answer for a
// known and an unknown address is what stops this form enumerating accounts.
import { currentUserNode } from "@blokjs/auth";
import { http, workflow } from "@blokjs/core";
import { always, definePage } from "@blokjs/inertia";

/** The page CONTRACT: every key is a prop, every value the node that produces it. */
export const ForgotPasswordPage = definePage("Auth/ForgotPassword", { auth: always(currentUserNode) });

export default workflow(
	"auth.forgotPasswordPage",
	{ version: "1.0.0", trigger: http.get("/forgot-password") },
	(req) => {
		ForgotPasswordPage.render(req, "page", "/forgot-password", {});
	},
);
`,
	"forgot-password.ts": `// \`POST /forgot-password\` — issue a single-use reset link (blokctl add spa --kit auth).
//
// The shape every Blok form has:
//   1. \`@blokjs/validate\` checks the body and returns \`{ ok, data, errors }\` —
//      it never throws, because a form failure is data;
//   2. \`branch()\` on \`checked.ok\` splits success from failure;
//   3. the failure arm bounces back with the errors, the success arm runs the
//      auth node, which answers with a 303.
import { ForgotPasswordSchema, bounceNode, forgotPasswordNode } from "@blokjs/auth";
import { http, type Handle, branch, node, step, workflow } from "@blokjs/core";

/** \`@blokjs/validate\` by ref — it lives in \`@blokjs/helpers\`, which every Blok app has. */
const validate = node<{ ok: boolean; data: Record<string, unknown>; errors: Record<string, unknown> }>(
	"@blokjs/validate",
);

/** The HTTP entry handle, named for the fields this workflow reads. */
type Req = Handle<{ body: unknown; params: Record<string, string>; query: Record<string, string> }>;

export default workflow(
	"auth.forgotPassword",
	{ version: "1.0.0", trigger: http.post("/forgot-password") },
	(entry) => {
		const req = entry as unknown as Req;
		const checked = step("validate", validate, { schema: ForgotPasswordSchema, data: req.body });
		branch("gate", checked.ok, {
			then: () => {
				step("forgot", forgotPasswordNode, { body: checked.data });
			},
			else: () => {
				step("errors", bounceNode, { errors: checked.errors, fallback: "/forgot-password" });
			},
		});
	},
);
`,
	"reset-password-page.ts": `// \`GET /reset-password/:token\` — the reset form (blokctl add spa --kit auth).
//
// The token rides the URL onto the page as a real prop, so the form can post it
// back. Nothing is looked up here: a token is only ever CHECKED when it is
// spent, by the POST below.
import { currentUserNode, resetTokenNode } from "@blokjs/auth";
import { http, type Handle, tpl, workflow } from "@blokjs/core";
import { always, definePage } from "@blokjs/inertia";

export const ResetPasswordPage = definePage("Auth/ResetPassword", {
	auth: always(currentUserNode),
	reset: resetTokenNode,
});

type Req = Handle<{ params: Record<string, string>; query: Record<string, string> }>;

export default workflow(
	"auth.resetPasswordPage",
	{ version: "1.0.0", trigger: http.get("/reset-password/:token") },
	(entry) => {
		const req = entry as unknown as Req;
		// \`render()\`'s \`url\` is typed \`string | Handle<string>\` and \`tpl\` returns
		// the structural \`$tpl\` shape, which the page step passes through to the
		// serializer like any other embedded handle. The cast NAMES that
		// type-surface gap rather than hiding it.
		const url = tpl\`/reset-password/\${req.params.token}\` as unknown as Handle<string>;
		ResetPasswordPage.render(req, "page", url, {
			reset: { token: req.params.token, email: req.query.email },
		});
	},
);
`,
	"reset-password.ts": `// \`POST /reset-password/:token\` — spend the token, set the password.
//
// The token is validated as part of the body (the form posts it back), and the
// PATH param is what the node is given: a form field cannot point the reset at
// another link.
import { ResetPasswordSchema, bounceNode, resetPasswordNode } from "@blokjs/auth";
import { http, type Handle, branch, node, step, workflow } from "@blokjs/core";

/** \`@blokjs/validate\` by ref — it lives in \`@blokjs/helpers\`, which every Blok app has. */
const validate = node<{ ok: boolean; data: Record<string, unknown>; errors: Record<string, unknown> }>(
	"@blokjs/validate",
);

/** The HTTP entry handle, named for the fields this workflow reads. */
type Req = Handle<{ body: unknown; params: Record<string, string>; query: Record<string, string> }>;

export default workflow(
	"auth.resetPassword",
	{ version: "1.0.0", trigger: http.post("/reset-password/:token") },
	(entry) => {
		const req = entry as unknown as Req;
		const checked = step("validate", validate, { schema: ResetPasswordSchema, data: req.body });
		branch("gate", checked.ok, {
			then: () => {
				step("reset", resetPasswordNode, { body: checked.data, token: req.params.token });
			},
			else: () => {
				step("errors", bounceNode, { errors: checked.errors, fallback: "/forgot-password" });
			},
		});
	},
);
`,
	"dashboard.ts": `// \`GET /dashboard\` — the guarded landing page (blokctl add spa --kit auth).
//
// \`AUTH_GUARD\` is \`inertia.auth\`: a guest is redirected to /login BEFORE any
// step here runs, and the response is marked no-store, so the browser cannot
// re-render it from history after sign-out.
import { AUTH_GUARD, currentUserNode } from "@blokjs/auth";
import { http, workflow } from "@blokjs/core";
import { always, definePage } from "@blokjs/inertia";

export const DashboardPage = definePage("Dashboard", { auth: always(currentUserNode) });

export default workflow(
	"auth.dashboard",
	{ version: "1.0.0", trigger: http.get("/dashboard", { middleware: [AUTH_GUARD] }) },
	(req) => {
		DashboardPage.render(req, "page", "/dashboard", {});
	},
);
`,
};
