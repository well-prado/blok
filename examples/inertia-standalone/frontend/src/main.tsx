import { createInertiaApp } from "@inertiajs/react";
import { createRoot } from "react-dom/client";
import "./blok-routes.js";

const BACKEND = import.meta.env.VITE_BLOK_URL ?? "http://localhost:4000";

/**
 * Standalone mode: the first page is NOT in a `data-page` attribute — the SPA
 * fetches it from the backend, cross-origin, with credentials on.
 */
void createInertiaApp({
	page: await fetch(`${BACKEND}${window.location.pathname}`, {
		credentials: "include",
		headers: { "X-Inertia": "true", "X-Inertia-Version": import.meta.env.BLOK_ASSET_VERSION ?? "" },
	}).then((response) => response.json()),
	resolve: (name: string) => import(`./pages/${name}.tsx`),
	setup({ el, App, props }) {
		createRoot(el).render(<App {...props} />);
	},
});
