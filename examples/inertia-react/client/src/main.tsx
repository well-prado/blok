import { createInertiaApp } from "@inertiajs/react";
import { createRoot } from "react-dom/client";

void createInertiaApp({
	resolve: (name: string) => import(`./pages/${name}.tsx`),
	setup({ el, App, props }) {
		createRoot(el).render(<App {...props} />);
	},
});
