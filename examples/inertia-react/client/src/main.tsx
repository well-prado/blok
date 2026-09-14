import { createInertiaApp } from "@inertiajs/react";
import { createRoot } from "react-dom/client";
// Vite hashes this into its own chunk; the Blok shell links it from
// `.blok-vite.json` (#1051).
import "./app.css";

void createInertiaApp({
	resolve: (name: string) => import(`./pages/${name}.tsx`),
	setup({ el, App, props }) {
		createRoot(el).render(<App {...props} />);
	},
});
