/**
 * The kit's page contracts (#1018) — `definePage()` declarations for the five
 * screens the auth slice ships.
 *
 * These are the SERVER half: the component names and prop types a
 * React/Vue/Svelte page binds to. The components themselves arrive with the
 * `blokctl add spa --kit auth` generator (#999); until then these contracts are
 * what the workflows render and what the tests assert against, and
 * `PageProps<typeof LoginPage>` already types a hand-written component.
 *
 * Every page carries `auth` so a layout can show "signed in as …" without each
 * page wiring it; `errors` is added by the serializer on every page.
 */

import { always, definePage } from "@blokjs/inertia";
import { currentUserNode, resetTokenNode } from "../nodes.js";

/** `Auth/Login` — the sign-in form. Errors land on `props.errors.email`. */
export const LoginPage = definePage("Auth/Login", { auth: always(currentUserNode) });

/** `Auth/Register` — name / email / password / confirmation. */
export const RegisterPage = definePage("Auth/Register", { auth: always(currentUserNode) });

/** `Auth/ForgotPassword` — one email field; the outcome arrives as `page.flash.status`. */
export const ForgotPasswordPage = definePage("Auth/ForgotPassword", { auth: always(currentUserNode) });

/** `Auth/ResetPassword` — the token from the URL, echoed so the form can post it back. */
export const ResetPasswordPage = definePage("Auth/ResetPassword", {
	auth: always(currentUserNode),
	reset: resetTokenNode,
});

/** `Dashboard` — the guarded landing page. */
export const DashboardPage = definePage("Dashboard", { auth: always(currentUserNode) });
