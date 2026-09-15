<script module lang="ts">
// Inertia keeps the layout MOUNTED across visits; only this page swaps.
export { default as layout } from "../../components/GuestLayout.svelte";
</script>

<script lang="ts">
/**
 * `Auth/Register` — create an account (#1018).
 *
 * The field names are the kit's `RegisterSchema` (`@blokjs/auth`): rename one
 * here and the server's error keys stop matching. Success starts a session and
 * lands on `/dashboard`; a duplicate address comes back as `errors.email`.
 */
import { Link, useForm } from "@inertiajs/svelte";
import { pageTitle } from "../../title.js";

const form = useForm("post", "/register", {
	name: "",
	email: "",
	password: "",
	passwordConfirmation: "",
});

function submit(event: SubmitEvent): void {
	event.preventDefault();
	form.post("/register", { onFinish: () => form.reset("password", "passwordConfirmation") });
}
</script>

<svelte:head><title>{pageTitle("Create an account")}</title></svelte:head>

<h1>Create an account</h1>
<p class="blok-lede">Takes a moment. No email confirmation in the scaffold.</p>

<form class="blok-form" onsubmit={submit}>
	<div class="blok-field">
		<label class="blok-label" for="name">Name</label>
		<input
			id="name"
			name="name"
			autocomplete="name"
			class="blok-input"
			bind:value={form.name}
			aria-invalid={form.errors.name ? true : undefined}
			aria-describedby={form.errors.name ? "name-error" : undefined}
		/>
		{#if form.errors.name}
			<p class="blok-error" id="name-error">{form.errors.name}</p>
		{/if}
	</div>

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
			autocomplete="new-password"
			class="blok-input"
			bind:value={form.password}
			aria-invalid={form.errors.password ? true : undefined}
			aria-describedby={form.errors.password ? "password-error" : "password-hint"}
		/>
		{#if form.errors.password}
			<p class="blok-error" id="password-error">{form.errors.password}</p>
		{:else}
			<p class="blok-hint" id="password-hint">At least 8 characters.</p>
		{/if}
	</div>

	<div class="blok-field">
		<label class="blok-label" for="passwordConfirmation">Confirm password</label>
		<input
			id="passwordConfirmation"
			name="passwordConfirmation"
			type="password"
			autocomplete="new-password"
			class="blok-input"
			bind:value={form.passwordConfirmation}
			aria-invalid={form.errors.passwordConfirmation ? true : undefined}
			aria-describedby={form.errors.passwordConfirmation ? "confirm-error" : undefined}
		/>
		{#if form.errors.passwordConfirmation}
			<p class="blok-error" id="confirm-error">{form.errors.passwordConfirmation}</p>
		{/if}
	</div>

	<div class="blok-form__actions">
		<button type="submit" class="blok-btn blok-btn--primary" disabled={form.processing}>
			{#if form.processing}<span class="blok-spinner"></span>{/if}
			{form.processing ? "Creating…" : "Create account"}
		</button>
		<Link href="/login" class="blok-btn">I already have one</Link>
	</div>
</form>
