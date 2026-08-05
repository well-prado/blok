import { defineNode } from "@blokjs/runner";
import type { Context } from "@blokjs/shared";
import { z } from "zod";

/**
 * login-fixture-ui — deterministic local fixture site for the browser E2E
 * demo (`e2e-login` workflow, workflow-canvas plan §17). Two pages:
 *
 *   - `login`: email/password form that POSTs to /fixtures/dashboard.
 *   - `dashboard`: shows "Welcome, <email>" when `authed` is true, an
 *     "Invalid credentials" banner otherwise — so the wrong-password
 *     scenario fails the text assertion while the URL assertion passes.
 *
 * No JS, no external assets, no network: everything the E2E asserts on is
 * rendered server-side, keeping runs reproducible offline and in CI.
 */
const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:24rem;margin:4rem auto;padding:0 1rem;color:#18181b}
label{display:block;margin:.75rem 0 .25rem;font-size:.875rem}
input{width:100%;padding:.5rem;border:1px solid #d4d4d8;border-radius:.375rem;font-size:1rem}
button{margin-top:1rem;padding:.5rem 1.25rem;border:0;border-radius:.375rem;background:#10b981;color:#fff;font-size:1rem}
.error{padding:.75rem;border:1px solid #fca5a5;border-radius:.375rem;background:#fef2f2;color:#b91c1c}
</style></head>
<body>${body}</body>
</html>`;

const escapeHtml = (value: string) =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export default defineNode({
	name: "login-fixture-ui",
	description: "Renders the deterministic login/dashboard fixture pages for the browser E2E demo.",
	contentType: "text/html",
	input: z.object({
		page: z.enum(["login", "dashboard"]).describe("Which fixture page to render."),
		email: z.string().default("").describe("Dashboard only: the signed-in email echoed in the welcome header."),
		authed: z.boolean().default(false).describe("Dashboard only: false renders the invalid-credentials state."),
	}),
	output: z.string(),
	async execute(_ctx: Context, input) {
		if (input.page === "login") {
			return page(
				"Sign in — Blok fixture",
				`<h1>Sign in</h1>
<form method="post" action="/fixtures/dashboard">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" required>
  <button type="submit">Sign in</button>
</form>`,
			);
		}
		if (!input.authed) {
			return page(
				"Sign in failed — Blok fixture",
				`<h1>Sign in failed</h1>
<p class="error" data-testid="error">Invalid credentials</p>
<p><a href="/fixtures/login">Back to sign in</a></p>`,
			);
		}
		return page(
			"Dashboard — Blok fixture",
			`<h1 data-testid="welcome">Welcome, ${escapeHtml(input.email)}</h1>
<p>You are signed in to the Blok fixture app.</p>`,
		);
	},
});
