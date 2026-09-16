import { blokInertia } from "@blokjs/inertia-client/vite";
import react from "@vitejs/plugin-react";
import { type UserConfig, defineConfig } from "vite";

export default defineConfig({
	plugins: [
		...react(),
		// `proxy: false` IS standalone mode: the SPA keeps its own origin and the
		// backend must send CORS (BLOK_CORS_ORIGIN) that EXPOSES the Inertia
		// response headers.
		...blokInertia({ pages: { path: "src/pages", extension: [".tsx"] }, proxy: false }),
	] as UserConfig["plugins"],
});
