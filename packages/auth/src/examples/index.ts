/**
 * `@blokjs/auth/examples` — the kit's reference page contracts and workflows.
 *
 * Importable on purpose: the integration tests register this exact map through
 * a live `HttpTrigger`, so the example IS the tested code rather than a snippet
 * that drifts. `blokctl add spa --kit auth` (#999) copies these files into a
 * project so an app can edit them.
 */

export {
	DashboardPage,
	ForgotPasswordPage,
	LoginPage,
	RegisterPage,
	ResetPasswordPage,
} from "./pages.js";
export {
	authWorkflows,
	dashboardWorkflow,
	forgotPasswordPageWorkflow,
	forgotPasswordWorkflow,
	loginPageWorkflow,
	loginWorkflow,
	logoutWorkflow,
	registerPageWorkflow,
	registerWorkflow,
	resetPasswordPageWorkflow,
	resetPasswordWorkflow,
} from "./workflows.js";
