<script module lang="ts">
export { default as layout } from "../../components/AppLayout.svelte";
</script>

<script lang="ts">
/**
 * The default production error component (#1014). `@blokjs/inertia` renders
 * `Errors/Error` for 403/404/500/503 with exactly these two props — it is NOT
 * a `definePage()` contract, so it is typed inline. `message` is the status's
 * standard reason phrase, never the thrown error's message.
 */
import { Link } from "@inertiajs/svelte";
import { pageTitle } from "../../title.js";

const { status, message }: { status: number; message: string } = $props();

const HELP: Record<number, string> = {
	403: "You are signed in, but this page is not yours to open.",
	404: "The link may be out of date, or that route does not exist yet.",
	500: "Something broke on the server. The failure was logged — try again in a moment.",
	503: "The app is restarting or under maintenance. This usually clears in a few seconds.",
};

const help = $derived(HELP[status] ?? "That request could not be completed.");
</script>

<svelte:head>
	<title>{pageTitle(`${status} ${message}`)}</title>
</svelte:head>

<div class="blok-error-page">
	<div>
		<p class="blok-error-page__status">{status}</p>
		<h1>{message}</h1>
		<p>{help}</p>
		<Link href="/" class="blok-btn blok-btn--primary">Back home</Link>
	</div>
</div>
