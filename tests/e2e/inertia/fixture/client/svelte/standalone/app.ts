import { http, axiosAdapter } from "@inertiajs/core";
import { createInertiaApp } from "@inertiajs/svelte";
import axios from "axios";
import { client as precognition } from "laravel-precognition";
import "./blok-routes.js";
import { listenForFlash } from "./flash-toast.js";
import "./styles/blok.css";
import { initTheme, installFavicon } from "./styles/theme.js";

/**
 * The STANDALONE entry — see `client/react/standalone/app.tsx` for the why.
 * No `title:` here: `@inertiajs/svelte` has no `<Head>` and its head manager
 * hard-codes the title resolver, so each page writes its own `<svelte:head>`.
 */
const backend = new URL(import.meta.env.VITE_BLOK_URL ?? "http://127.0.0.1:4600");

// `withXSRFToken` is not implied by `withCredentials`: axios drops the
// double-submit header on a CROSS-ORIGIN request unless it is set, so every
// write would fail the CSRF guard and bounce back instead of running.
http.setClient(axiosAdapter(axios.create({ withCredentials: true, withXSRFToken: true })));
// Precognition is a SECOND transport: `laravel-precognition` owns its own
// client, so `form.validate()` would probe the SPA's own server (404) with no
// cookies. `withBaseURL` + `withCredentials` are its public knobs for exactly
// this deployment shape.
precognition.withBaseURL(backend.origin).withCredentials(true);
http.onRequest((config) => {
	const url = new URL(config.url, window.location.href);
	if (url.origin !== window.location.origin) return config;
	url.protocol = backend.protocol;
	url.host = backend.host;
	return { ...config, url: url.toString() };
});

initTheme();
installFavicon();
listenForFlash();

void createInertiaApp({
	pages: "./pages",
	progress: { color: "#2bcd71" },
	page: await fetch(new URL(`${window.location.pathname}${window.location.search}`, backend), {
		credentials: "include",
		headers: { "X-Inertia": "true" },
	}).then((response) => response.json()),
});
