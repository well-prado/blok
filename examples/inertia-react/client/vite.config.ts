import { blokInertia } from "@blokjs/inertia-client/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		react(),
		// Wraps @inertiajs/vite: page resolution, lazy pages and the SSR transform
		// are upstream. On top it writes .blok-asset-version, pages.json and
		// .blok-ssr-url into outDir, and proxies non-Vite paths to the Blok server.
		blokInertia({
			pages: { path: "src/pages", extension: [".tsx"] },
			proxy: { target: process.env.BLOK_URL ?? "http://localhost:4000" },
		}),
	],
});
