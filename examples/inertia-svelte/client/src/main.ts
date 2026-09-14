import { createInertiaApp } from "@inertiajs/svelte";
import { mount } from "svelte";

// No `resolve`: `@inertiajs/vite` (which `blokInertia()` wraps) injects an
// `import.meta.glob("./pages/**/*.svelte")` resolver at build time.
// Hand-writing `import(`./pages/${name}.svelte`)` looks equivalent and is not —
// Vite resolves a template-literal dynamic import only ONE directory deep, so a
// nested page throws "Unknown variable dynamic import" in production.
void createInertiaApp({
	setup({ el, App, props }) {
		// `el` is the root the shell rendered — present by the time setup runs.
		if (el) mount(App, { target: el, props });
	},
});
