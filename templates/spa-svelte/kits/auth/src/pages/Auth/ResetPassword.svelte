<script module lang="ts">
// Inertia keeps the layout MOUNTED across visits; only this page swaps.
export { default as layout } from "../../components/GuestLayout.svelte";
</script>

<script lang="ts">
/**
 * `Auth/ResetPassword` — choose a new password (#1018).
 *
 * `reset` is a real page prop: the `:token` from the URL, echoed by the kit's
 * `resetToken` node so the form can post it back. The token is single-use and
 * expires; the server checks it when it is SPENT, never here.
 */
import type { PageProps } from "@blokjs/inertia-client";
import { Link, useForm } from "@inertiajs/svelte";
import { pageTitle } from "../../title.js";

const { reset }: PageProps<"Auth/ResetPassword"> = $props();

// `$derived` and a data CALLBACK, not plain reads: a top-level read of a
// `$props()` value captures only its initial value, and Svelte's compiler says
// so (`state_referenced_locally`). The same component can be reached with a
// different token without remounting.
const url = $derived(`/reset-password/${reset.token}`);
const form = useForm("post", () => url, () => ({
	token: reset.token,
	email: reset.email ?? "",
	password: "",
	passwordConfirmation: "",
}));

function submit(event: SubmitEvent): void {
	event.preventDefault();
	form.post(url, { onFinish: () => form.reset("password", "passwordConfirmation") });
}
</script>

<svelte:head><title>{pageTitle("Choose a new password")}</title></svelte:head>

<h1>Choose a new password</h1>
<p class="blok-lede">This link works once.</p>

<form class="blok-form" onsubmit={submit}>
	<div class="blok-field">
		<label class="blok-label" for="email">Email</label>
		<input
			id="email"
			name="email"
			type="email"
			autocomplete="username"
			class="blok-input"
			bind:value={form.email}
			aria-invalid={form.errors.email ? true : undefined}
			aria-describedby={form.errors.email ? "email-error" : undefined}
		/>
		{#if form.errors.email}
			<p class="blok-error" id="email-error">{form.errors.email}</p>
		{/if}
	</div>

	<div class="blok-field">
		<label class="blok-label" for="password">New password</label>
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
		<label class="blok-label" for="passwordConfirmation">Confirm new password</label>
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
			{form.processing ? "Saving…" : "Reset password"}
		</button>
		<Link href="/login" class="blok-btn">Back to sign in</Link>
	</div>
</form>
