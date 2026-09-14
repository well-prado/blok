import { createInertiaApp } from "@inertiajs/vue3";
import { createApp, h } from "vue";

// No `resolve`: `@inertiajs/vite` (which `blokInertia()` wraps) injects an
// `import.meta.glob("./pages/**/*.vue")` resolver at build time. Hand-writing
// `import(`./pages/${name}.vue`)` looks equivalent and is not — Vite resolves a
// template-literal dynamic import only ONE directory deep, so a nested page
// like `Orders/Create` throws "Unknown variable dynamic import" in production.
void createInertiaApp({
	setup({ el, App, props, plugin }) {
		// `el` is the root the shell rendered — present by the time setup runs.
		if (el)
			createApp({ render: () => h(App, props) })
				.use(plugin)
				.mount(el);
	},
});
