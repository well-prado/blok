import { createInertiaApp } from "@inertiajs/vue3";
import { createApp, h } from "vue";

void createInertiaApp({
	resolve: (name: string) => import(`./pages/${name}.vue`),
	setup({ el, App, props, plugin }) {
		createApp({ render: () => h(App, props) })
			.use(plugin)
			.mount(el);
	},
});
