import { http, axiosAdapter } from "@inertiajs/core";
import { createInertiaApp } from "@inertiajs/react";
import axios from "axios";
import { client as precognition } from "laravel-precognition";
import "./blok-routes.js";
import { listenForFlash } from "./flash-toast.js";
import "./styles/blok.css";
import { initTheme, installFavicon } from "./styles/theme.js";

/**
 * The STANDALONE entry — the SPA on its own origin, Blok on another.
 *
 * Three things are the app's job here, and none of them are in the scaffold:
 *
 * 1. **The first page object.** Blok renders no shell in this mode, so there is
 *    no `data-page` attribute to boot from: the client fetches it.
 * 2. **Where the protocol goes.** The router resolves every visit against
 *    `window.location`, so by the time a request reaches the HTTP client its URL
 *    is ABSOLUTE and on the SPA's origin — which is why an Axios `baseURL` does
 *    nothing. `http.onRequest()` is the supported hook that rewrites it. Only
 *    the transport moves; routing, history and the page object are unchanged.
 * 3. **Credentials.** The built-in XHR client never sets `withCredentials`, so
 *    cross-origin requests would carry no session, CSRF or flash cookie. The
 *    Axios adapter does, which is the half `BLOK_CORS_ORIGIN`'s
 *    `Access-Control-Allow-Credentials` exists to answer.
 *
 * `tests/e2e/inertia/fixture.ts` MOVES this file to `src/app.tsx` for the
 * standalone cells and deletes it for the in-project ones, so its imports are
 * written for `src/`, not for the `src/standalone/` directory it ships in.
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
	title: (title) => (title ? `${title} — blok e2e` : "blok e2e"),
	progress: { color: "#2bcd71" },
	page: await fetch(new URL(`${window.location.pathname}${window.location.search}`, backend), {
		credentials: "include",
		headers: { "X-Inertia": "true" },
	}).then((response) => response.json()),
});
