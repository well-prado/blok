<script setup lang="ts">
/**
 * The persistent layout. Inertia keeps this component MOUNTED across visits
 * (`defineOptions({ layout: AppLayout })` in each page), so the header and the
 * theme toggle survive navigation — only the page below swaps.
 */
import { Link, usePage } from "@inertiajs/vue3";
import { computed } from "vue";
import { toggleTheme } from "../styles/theme.js";
import BlokLogo from "./BlokLogo.vue";
import NavLinks, { type NavItem } from "./NavLinks.vue";

const NAV: NavItem[] = [
	{ href: "/", label: "Dashboard" },
	{ href: "https://blok.build", label: "Docs", external: true },
	{ href: "https://github.com/well-prado/blok", label: "GitHub", external: true },
];

const page = usePage<{ auth?: { email?: string } }>();
const email = computed(() => page.props.auth?.email);
</script>

<template>
	<div class="blok-shell">
		<header class="blok-header">
			<div class="blok-container blok-header__inner">
				<Link href="/" class="blok-brand" aria-label="Blok — dashboard">
					<BlokLogo :height="22" />
				</Link>

				<nav class="blok-nav" aria-label="Primary">
					<NavLinks :items="NAV" :current-url="page.url" />
				</nav>

				<div class="blok-header__end">
					<span v-if="email" class="blok-user">{{ email }}</span>
					<button
						type="button"
						class="blok-btn blok-btn--ghost blok-btn--icon blok-theme-toggle"
						aria-label="Switch between light and dark theme"
						@click="toggleTheme()"
					>
						<svg
							class="blok-icon--moon"
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
						</svg>
						<svg
							class="blok-icon--sun"
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<circle cx="12" cy="12" r="4" />
							<path
								d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
							/>
						</svg>
					</button>

					<!-- A native <details>: the 375px menu ships no JavaScript. -->
					<details class="blok-menu">
						<summary class="blok-btn blok-btn--ghost blok-btn--icon" aria-label="Menu">
							<svg
								width="16"
								height="16"
								viewBox="0 0 24 24"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								aria-hidden="true"
							>
								<path d="M3 6h18M3 12h18M3 18h18" />
							</svg>
						</summary>
						<div class="blok-menu__panel">
							<p v-if="email" class="blok-menu__user">{{ email }}</p>
							<nav class="blok-nav" aria-label="Primary, compact">
								<NavLinks :items="NAV" :current-url="page.url" />
							</nav>
						</div>
					</details>
				</div>
			</div>
		</header>

		<main class="blok-main">
			<div class="blok-container"><slot /></div>
		</main>

		<footer class="blok-footer">
			<div class="blok-container blok-footer__inner">
				<BlokLogo variant="mark" :height="16" />
				<span>Built with Blok</span>
				<span aria-hidden="true">·</span>
				<a href="https://blok.build" rel="noreferrer">blok.build</a>
				<span aria-hidden="true">·</span>
				<a href="https://github.com/well-prado/blok" rel="noreferrer">GitHub</a>
				<span aria-hidden="true">·</span>
				<a href="https://deskree.com" rel="noreferrer">Deskree</a>
			</div>
		</footer>
	</div>
</template>
