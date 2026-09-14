import { createInertiaApp } from "@inertiajs/svelte";
import { mount } from "svelte";
import { listenForFlash } from "./flash-toast.js";
// Vite hashes this into its own chunk; the Blok shell links it from
// `.blok-vite.json` (#1051). It is the Blok design system: the same bytes
// ship in every template and example.
import "./styles/blok.css";
import { initTheme, installFavicon } from "./styles/theme.js";

initTheme();
installFavicon();
listenForFlash();

// No `resolve`: `@inertiajs/vite` (which `blokInertia()` wraps) injects an
// `import.meta.glob("./pages/**/*.svelte")` resolver at build time.
// Hand-writing `import(`./pages/${name}.svelte`)` looks equivalent and is not —
// Vite resolves a template-literal dynamic import only ONE directory deep, so a
// nested page throws "Unknown variable dynamic import" in production.
void createInertiaApp({
	title: (title) => (title ? `${title} · Blok` : "Blok"),
	// The navigation bar at the top of the window, in the brand green.
	progress: { color: "#2bcd71" },
	setup({ el, App, props }) {
		// `el` is the root the shell rendered — present by the time setup runs.
		if (el) mount(App, { target: el, props });
	},
});
