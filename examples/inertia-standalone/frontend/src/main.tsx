import { createInertiaApp } from "@inertiajs/react";
import { createRoot } from "react-dom/client";
import "./blok-routes.js";
import { listenForFlash } from "./flash-toast.js";
import "./styles/blok.css";
import { initTheme, installFavicon } from "./styles/theme.js";

const BACKEND = import.meta.env.VITE_BLOK_URL ?? "http://localhost:4000";

initTheme();
installFavicon();
listenForFlash();

/**
 * Standalone mode: the first page is NOT in a `data-page` attribute — the SPA
 * fetches it from the backend, cross-origin, with credentials on.
 */
void createInertiaApp({
	title: (title) => (title ? `${title} · Blok` : "Blok"),
	progress: { color: "#2bcd71" },
	page: await fetch(`${BACKEND}${window.location.pathname}`, {
		credentials: "include",
		headers: { "X-Inertia": "true", "X-Inertia-Version": import.meta.env.BLOK_ASSET_VERSION ?? "" },
	}).then((response) => response.json()),
	// No `resolve`: `@inertiajs/vite` injects an
	// `import.meta.glob("./pages/**/*.tsx")` resolver at build time. Hand-writing
	// `import(`./pages/${name}.tsx`)` looks equivalent and is not — Vite resolves
	// a template-literal dynamic import only ONE directory deep, so a nested page
	// like `Orders/Index` throws "Unknown variable dynamic import" in production.
	setup({ el, App, props }) {
		// `el` is the root the shell rendered — present by the time setup runs.
		if (el) createRoot(el).render(<App {...props} />);
	},
});
