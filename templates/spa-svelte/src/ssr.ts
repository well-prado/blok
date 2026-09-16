import { createInertiaApp } from "@inertiajs/svelte";
import createServer from "@inertiajs/svelte/server";
import type { Component } from "svelte";
import { render } from "svelte/server";

// The SSR bundle resolves pages EAGERLY (one process, every page already in the
// bundle) and spells the resolver out, unlike the client entry's `pages`
// shorthand: `createInertiaApp` needs an explicit `resolve` when it is handed a
// page object instead of booting from the DOM.
const pages = import.meta.glob<{ default: Component }>("./pages/**/*.svelte", { eager: true });

// Inertia's SSR server (`POST /render` on :13714). `blokctl inertia start-ssr`
// boots the bundle this file produces (`dist-ssr/ssr.js`); the Blok server finds
// the endpoint through `dist/.blok-ssr-url`, written by `blokInertia()`.
createServer(
	(page) =>
		createInertiaApp({
			page,
			resolve: (name) => pages[`./pages/${name}.svelte`],
			setup: ({ App, props }) => render(App, { props }),
		}),
	{
		// #1003 — `createServer`'s port/host/cluster come from its SECOND argument,
		// never from the environment. Without this block
		// `blokctl inertia start-ssr --port/--host/--cluster` set BLOK_SSR_* and
		// the bundle ignored all three, always binding 13714 on 0.0.0.0.
		port: Number(process.env.BLOK_SSR_PORT ?? 13714),
		host: process.env.BLOK_SSR_HOST ?? "127.0.0.1",
		cluster: process.env.BLOK_SSR_CLUSTER === "true",
	},
);
