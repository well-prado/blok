<script module lang="ts">
// Inertia keeps the layout MOUNTED across visits; only this page swaps.
export { default as layout } from "../../components/GuestLayout.svelte";
</script>

<script lang="ts">
/**
 * `Auth/ForgotPassword` — ask for a reset link (#1018).
 *
 * The server answers the SAME way whether or not the address exists (anything
 * else turns this form into an account-enumeration oracle), so there is no
 * success/failure branch to render: the neutral message arrives as flash and
 * `flash-toast.ts` shows it.
 *
 * With no mailer configured the kit LOGS the link — look in the Blok server's
 * output, then `configureAuth({ sendResetLink })` to send it for real.
 */
import { Link, useForm } from "@inertiajs/svelte";
import { pageTitle } from "../../title.js";

const form = useForm("post", "/forgot-password", { email: "" });

function submit(event: SubmitEvent): void {
	event.preventDefault();
	form.post("/forgot-password");
}
</script>

<svelte:head><title>{pageTitle("Forgot your password?")}</title></svelte:head>

<h1>Forgot your password?</h1>
<p class="blok-lede">We will email you a link to choose a new one.</p>

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

	<div class="blok-form__actions">
		<button type="submit" class="blok-btn blok-btn--primary" disabled={form.processing}>
			{#if form.processing}<span class="blok-spinner"></span>{/if}
			{form.processing ? "Sending…" : "Email the link"}
		</button>
		<Link href="/login" class="blok-btn">Back to sign in</Link>
	</div>
</form>
