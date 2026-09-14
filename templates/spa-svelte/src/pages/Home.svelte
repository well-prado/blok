<script lang="ts">
import type { PageProps } from "@blokjs/inertia-client";
import { Link } from "@inertiajs/svelte";

const { home }: PageProps<"Home"> = $props();
</script>

<svelte:head>
	<title>Home</title>
</svelte:head>

<main style="font: 400 1rem/1.6 system-ui, sans-serif; margin: 0 auto; max-width: 40rem; padding: 4rem 1.5rem">
	<h1 style="font-size: 2rem; margin: 0 0 1rem">{home.title}</h1>
	<p>{home.body}</p>
	<Link href="/">Visit this page again — without a full reload</Link>
</main>
