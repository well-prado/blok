import { createInertiaApp } from "@inertiajs/react";
import { createRoot } from "react-dom/client";
// Vite hashes this into its own chunk; the Blok shell links it from
// `.blok-vite.json` (#1051).
import "./app.css";

// No `resolve`: `@inertiajs/vite` (which `blokInertia()` wraps) injects an
// `import.meta.glob("./pages/**/*.tsx")` resolver at build time. Hand-writing
// `import(`./pages/${name}.tsx`)` looks equivalent and is not — Vite resolves a
// template-literal dynamic import only ONE directory deep, so a nested page
// like `Orders/Create` throws "Unknown variable dynamic import" in production.
void createInertiaApp({
	setup({ el, App, props }) {
		// `el` is the root the shell rendered — present by the time setup runs.
		if (el) createRoot(el).render(<App {...props} />);
	},
});
