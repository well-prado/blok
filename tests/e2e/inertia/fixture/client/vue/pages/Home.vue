<script setup lang="ts">
/**
 * Home.
 *
 * Its copy comes through `homeCopy()`, the plain module typed with the
 * GENERATED `PageProps<"Home">` — which is what makes scenario 19 a real gate
 * for a framework whose components `tsc` cannot read: renaming `home:` in
 * `src/workflows/home.ts` and regenerating the types has to make the client
 * stop compiling.
 *
 * The prefetch and instant links live here rather than in the layout so a plain
 * `<Link>` click (scenario 2) cannot be confused with a prefetching one. They
 * are written as a `v-for`, and the payload comment lives HERE rather than in
 * the template, for the same SSR-hydration reason as `components/Layout.vue`:
 * literal whitespace and comments between sibling elements are exactly what the
 * SSR and client compilers disagree about.
 *
 * `copy.payload` carries a closing script tag and is rendered as TEXT;
 * `window.pwned` staying undefined is the end-to-end proof that the boot script
 * is escaped.
 */
import { Head, Link, usePage } from "@inertiajs/vue3";
import { computed } from "vue";
import Layout from "../components/Layout.vue";
import { type HomeProps, homeCopy } from "../page-props.js";

const page = usePage<HomeProps>();
const copy = computed(() => homeCopy(page.props));

const actions = [
	{ id: "prefetch-orders", href: "/orders", label: "Prefetch orders", prefetch: true },
	{ id: "instant-dashboard", href: "/dashboard", label: "Instant dashboard", prefetch: false },
];

defineOptions({ layout: Layout });
</script>

<template>
	<Head title="Home" />
	<h1 data-testid="page-heading">Home</h1>
	<p data-testid="home-body">{{ copy.body }}</p>
	<p data-testid="home-payload">{{ copy.payload }}</p>
	<Link
		v-for="action in actions"
		:key="action.id"
		:href="action.href"
		:data-testid="action.id"
		:prefetch="action.prefetch"
		:cache-for="action.prefetch ? '1s' : undefined"
		:instant="!action.prefetch"
		>{{ action.label }}</Link
	>
</template>
