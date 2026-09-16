<script module lang="ts">
export { default as layout } from "../components/Layout.svelte";
</script>

<script lang="ts">
import { router } from "@inertiajs/svelte";
import { pageTitle } from "../title.js";

const { auth }: { auth: { id: string; email: string } } = $props();
</script>

<svelte:head>
	<title>{pageTitle("Secret")}</title>
</svelte:head>

<h1 data-testid="page-heading">Secret</h1>
<p data-testid="secret-email">{auth.email}</p>
<button type="button" data-testid="logout" onclick={() => router.post("/logout")}>Logout</button>
