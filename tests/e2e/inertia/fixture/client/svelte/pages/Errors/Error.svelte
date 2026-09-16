<script module lang="ts">
export { default as layout } from "../../components/Layout.svelte";
</script>

<script lang="ts">
/** The production error page: a real Inertia response carrying a 4xx/5xx status. */
import { pageTitle } from "../../title.js";

const { status, message }: { status: number; message: string } = $props();
</script>

<svelte:head>
	<title>{pageTitle(String(status))}</title>
</svelte:head>

<h1 data-testid="page-heading">{status} — {message}</h1>
