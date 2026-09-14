<script lang="ts">
/**
 * A normal `<script>` alongside `<script setup>`: `<script setup>` cannot carry
 * ES exports, and this type is what `AppLayout` types its NAV array with.
 */
export interface NavItem {
	href: string;
	label: string;
	external?: boolean;
}
</script>

<script setup lang="ts">
/**
 * The primary nav, rendered twice — once in the header bar, once inside the
 * 375px `<details>` menu. It is its own component so the two cannot drift:
 * Vue has no snippet, and the duplicated `v-for` is exactly how the compact
 * menu lost its `aria-current`.
 */
import { Link } from "@inertiajs/vue3";

defineProps<{ items: NavItem[]; currentUrl: string }>();

/**
 * The 375px menu is a native `<details>` inside a PERSISTENT layout, so an
 * Inertia visit swaps the page underneath it and leaves it open, covering the
 * page it just navigated to. One line closes it; nothing else here needs JS.
 */
function closeMenu(event: MouseEvent): void {
	(event.currentTarget as HTMLElement | null)?.closest("details")?.removeAttribute("open");
}
</script>

<template>
	<template v-for="item in items" :key="item.href">
		<a v-if="item.external" :href="item.href" rel="noreferrer" @click.capture="closeMenu">{{ item.label }}</a>
		<!--
			`.capture` is load-bearing: `<Link>` renders with `{ ...attrs, ...events }`,
			so a plain `@click` lands on the same `onClick` key Inertia then overwrites
			and never fires. `@click.capture` is a different key (`onClickCapture`), so
			both handlers survive.
		-->
		<Link
			v-else
			:href="item.href"
			:aria-current="currentUrl === item.href ? 'page' : undefined"
			@click.capture="closeMenu"
		>
			{{ item.label }}
		</Link>
	</template>
</template>
