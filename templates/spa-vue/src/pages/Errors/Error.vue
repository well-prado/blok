<script setup lang="ts">
import { Head, Link } from "@inertiajs/vue3";

/**
 * The default production error component (#1014). `@blokjs/inertia` renders
 * `Errors/Error` for 403/404/500/503 with exactly these two props — it is NOT
 * a `definePage()` contract, so it is typed inline.
 */
defineProps<{ status: number; message: string }>();
</script>

<template>
	<main :style="{ font: '400 1rem/1.6 system-ui, sans-serif', margin: '0 auto', maxWidth: '40rem', padding: '4rem 1.5rem' }">
		<Head :title="String(status)" />
		<h1 :style="{ fontSize: '2rem', margin: '0 0 1rem' }">{{ status }} — {{ message }}</h1>
		<Link href="/">Back to the start</Link>
	</main>
</template>
