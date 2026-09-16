<script setup lang="ts">
/**
 * The persistent layout every fixture page mounts under.
 *
 * Inertia keeps this component MOUNTED across visits, so the navigation and the
 * signed-in identity survive a page swap — which is what scenarios 2, 3, 13, 35,
 * 36 and 37 navigate with. Every control carries a `data-testid`: the same ids
 * exist in the React and Svelte fixtures, so ONE spec drives all three.
 *
 * The nav is a `v-for` rather than five literal `<Link>`s for a reason that only
 * shows up under SSR: sibling elements written on their own lines leave
 * whitespace text nodes, and the SSR and client compilers disagree about them
 * ("Hydration completed but contains mismatches", after which Vue patches
 * attributes onto the wrong nodes — `nav-dashboard` ends up pointing at
 * `/orders`). A `v-for` fragment has no literal whitespace to disagree about.
 */
import { Link, usePage } from "@inertiajs/vue3";
import { computed, onMounted, ref } from "vue";

const page = usePage<{ auth?: { email?: string } }>();
const email = computed(() => page.props.auth?.email ?? "");

// See `client/react/components/Layout.tsx` — the SSR pre-hydration click race.
const hydrated = ref(false);
onMounted(() => {
	hydrated.value = true;
});

const nav = [
	{ id: "nav-home", href: "/", label: "Home" },
	{ id: "nav-orders", href: "/orders", label: "Orders" },
	{ id: "nav-dashboard", href: "/dashboard", label: "Dashboard" },
	{ id: "nav-secret", href: "/secret", label: "Secret" },
	{ id: "nav-login", href: "/login", label: "Login" },
];
</script>

<template>
	<div :data-hydrated="hydrated ? 'true' : undefined">
		<header>
			<nav>
				<Link v-for="item in nav" :key="item.id" :href="item.href" :data-testid="item.id">{{ item.label }}</Link>
			</nav>
			<span data-testid="auth-email">{{ email }}</span>
		</header>
		<main><slot /></main>
	</div>
</template>
