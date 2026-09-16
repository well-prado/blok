<script module lang="ts">
export { default as layout } from "../components/Layout.svelte";
</script>

<script lang="ts">
import { useForm } from "@inertiajs/svelte";
import { pageTitle } from "../title.js";

// `to` is where the fixture's login node redirects once the session cookie is
// set — /secret, the page scenario 12's guard bounced the guest away from.
const form = useForm({ email: "", password: "", to: "/secret" });

function submit(event: SubmitEvent): void {
	event.preventDefault();
	form.post("/login");
}
</script>

<svelte:head>
	<title>{pageTitle("Login")}</title>
</svelte:head>

<h1 data-testid="page-heading">Login</h1>
<form data-testid="form-login" onsubmit={submit}>
	<label for="email">Email</label>
	<input id="email" data-testid="email" bind:value={form.email} />
	<label for="password">Password</label>
	<input id="password" type="password" data-testid="password" bind:value={form.password} />
	<button type="submit" data-testid="submit-login">Sign in</button>
</form>
