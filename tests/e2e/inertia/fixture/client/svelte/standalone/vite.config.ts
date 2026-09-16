import { blokInertia } from "@blokjs/inertia-client/vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { type UserConfig, defineConfig } from "vite";

/** `proxy: false` IS standalone mode — see `client/react/standalone/vite.config.ts`. */
export default defineConfig({
	plugins: [...svelte(), ...blokInertia({ proxy: false })] as UserConfig["plugins"],
});
