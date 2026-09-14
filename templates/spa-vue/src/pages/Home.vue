<script setup lang="ts">
import type { PageProps } from "@blokjs/inertia-client";
import { Head, Link, usePage } from "@inertiajs/vue3";

// ponytail: `usePage<PageProps<"Home">>()` rather than
// `defineProps<PageProps<"Home">>()`. @vue/compiler-sfc resolves prop TYPES
// itself, with its own resolver: it cannot follow the generic indexed access
// inside `PageProps`, and it never sees the `declare module` augmentation in
// `blok-pages.d.ts` either. `usePage` is plain TypeScript, so both stay honest.
const page = usePage<PageProps<"Home">>();
</script>

<template>
	<main style="font: 400 1rem/1.6 system-ui, sans-serif; margin: 0 auto; max-width: 40rem; padding: 4rem 1.5rem">
		<Head title="Home" />
		<h1 style="font-size: 2rem; margin: 0 0 1rem">{{ page.props.home.title }}</h1>
		<p>{{ page.props.home.body }}</p>
		<Link href="/">Visit this page again — without a full reload</Link>
	</main>
</template>
