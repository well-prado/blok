<script module lang="ts">
// Inertia keeps the layout MOUNTED across visits; only this page swaps.
export { default as layout } from "../../components/GuestLayout.svelte";
</script>

<script lang="ts">
/**
 * `Auth/Login` — the sign-in form (#1018).
 *
 * An ordinary Inertia form posting to the kit's `POST /login` workflow.
 * Everything Blok-specific is on the server: `@blokjs/validate` checks the
 * body, `@blokjs/auth`'s `login` node verifies the password (throttled per
 * IP + email), starts a fresh session and answers 303. A failure redirects
 * back with `props.errors.email` — which is what `form.errors.email` reads.
 */
import { Link, useForm } from "@inertiajs/svelte";
import { pageTitle } from "../../title.js";

const form = useForm("post", "/login", { email: "", password: "", remember: false });

function submit(event: SubmitEvent): void {
	event.preventDefault();
	form.post("/login", { onFinish: () => form.reset("password") });
}
</script>

<svelte:head><title>{pageTitle("Sign in")}</title></svelte:head>

<h1>Sign in</h1>
<p class="blok-lede">Welcome back.</p>

<form class="blok-form" onsubmit={submit}>
	<div class="blok-field">
		<label class="blok-label" for="email">Email</label>
		<input
			id="email"
			name="email"
			type="email"
			autocomplete="username"
			class="blok-input"
			placeholder="you@example.com"
			bind:value={form.email}
			aria-invalid={form.errors.email ? true : undefined}
			aria-describedby={form.errors.email ? "email-error" : undefined}
		/>
		{#if form.errors.email}
			<p class="blok-error" id="email-error">{form.errors.email}</p>
		{/if}
	</div>

	<div class="blok-field">
		<label class="blok-label" for="password">Password</label>
		<input
			id="password"
			name="password"
			type="password"
			autocomplete="current-password"
			class="blok-input"
			bind:value={form.password}
			aria-invalid={form.errors.password ? true : undefined}
			aria-describedby={form.errors.password ? "password-error" : undefined}
		/>
		{#if form.errors.password}
			<p class="blok-error" id="password-error">{form.errors.password}</p>
		{/if}
	</div>

	<div class="blok-guest__row">
		<label class="blok-check" for="remember">
			<input id="remember" name="remember" type="checkbox" bind:checked={form.remember} />
			Remember me
		</label>
		<Link href="/forgot-password">Forgot your password?</Link>
	</div>

	<div class="blok-form__actions">
		<button type="submit" class="blok-btn blok-btn--primary" disabled={form.processing}>
			{#if form.processing}<span class="blok-spinner"></span>{/if}
			{form.processing ? "Signing in…" : "Sign in"}
		</button>
		<Link href="/register" class="blok-btn">Create an account</Link>
	</div>
</form>
