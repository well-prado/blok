import { createInertiaApp } from "@inertiajs/svelte";
import { mount } from "svelte";

void createInertiaApp({
	resolve: (name: string) => import(`./pages/${name}.svelte`),
	setup({ el, App, props }) {
		// `el` is the root the shell rendered — present by the time setup runs.
		if (el) mount(App, { target: el, props });
	},
});
