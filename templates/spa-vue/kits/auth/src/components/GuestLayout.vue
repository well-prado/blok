<script setup lang="ts">
/**
 * The layout for the signed-OUT screens (#1018): one centred card, no nav, no
 * user menu — there is no user yet.
 *
 * Like `AppLayout` it is a PERSISTENT Inertia layout, so moving between
 * sign-in, register and password reset swaps only the card's contents.
 */
import { Link } from "@inertiajs/vue3";
import "../styles/auth.css";
import { toggleTheme } from "../styles/theme.js";
import BlokLogo from "./BlokLogo.vue";
</script>

<template>
	<div class="blok-guest">
		<button
			type="button"
			class="blok-btn blok-btn--ghost blok-btn--icon blok-theme-toggle blok-guest__toggle"
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

		<div class="blok-guest__card">
			<Link href="/" class="blok-guest__brand" aria-label="Blok — home">
				<BlokLogo :height="24" />
			</Link>
			<slot />
		</div>

		<p class="blok-guest__foot">
			<span>Built with Blok</span>
			<span aria-hidden="true">·</span>
			<a href="https://blok.build/d/spa/starter-kit" rel="noreferrer">Starter kit docs</a>
		</p>
	</div>
</template>
