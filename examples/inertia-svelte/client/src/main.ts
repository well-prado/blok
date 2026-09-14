import { createInertiaApp } from "@inertiajs/svelte";
import { mount } from "svelte";

void createInertiaApp({
	resolve: (name: string) => import(`./pages/${name}.svelte`),
	setup({ el, App, props }) {
		mount(App, { target: el, props });
	},
});
