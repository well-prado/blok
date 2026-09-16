import { blokInertia } from "@blokjs/inertia-client/vite";
import vue from "@vitejs/plugin-vue";
import { type UserConfig, defineConfig } from "vite";

/** `proxy: false` IS standalone mode — see `client/react/standalone/vite.config.ts`. */
export default defineConfig({
	plugins: [vue(), ...blokInertia({ proxy: false })] as UserConfig["plugins"],
});
