<script lang="ts">
import { Link } from "@inertiajs/svelte";

/**
 * The default production error component (#1014). `@blokjs/inertia` renders
 * `Errors/Error` for 403/404/500/503 with exactly these two props — it is NOT
 * a `definePage()` contract, so it is typed inline.
 */
const { status, message }: { status: number; message: string } = $props();
</script>

<svelte:head>
	<title>{status}</title>
</svelte:head>

<main style="font: 400 1rem/1.6 system-ui, sans-serif; margin: 0 auto; max-width: 40rem; padding: 4rem 1.5rem">
	<h1 style="font-size: 2rem; margin: 0 0 1rem">{status} — {message}</h1>
	<Link href="/">Back to the start</Link>
</main>
