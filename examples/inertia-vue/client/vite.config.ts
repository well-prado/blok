import { blokInertia } from "@blokjs/inertia-client/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		vue(),
		blokInertia({
			pages: { path: "src/pages", extension: [".vue"] },
			proxy: { target: process.env.BLOK_URL ?? "http://localhost:4000" },
		}),
	],
});
