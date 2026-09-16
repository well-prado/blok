import { blokInertia } from "@blokjs/inertia-client/vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { type UserConfig, defineConfig } from "vite";

export default defineConfig({
	plugins: [
		...svelte(),
		...blokInertia({
			pages: { path: "src/pages", extension: [".svelte"] },
			proxy: { target: process.env.BLOK_URL ?? "http://localhost:4000" },
		}),
	] as UserConfig["plugins"],
});
