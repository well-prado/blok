import { blokInertia } from "@blokjs/inertia-client/vite";
import react from "@vitejs/plugin-react";
import { type UserConfig, defineConfig } from "vite";

/**
 * `proxy: false` IS standalone mode.
 *
 * `blokctl create spa --blok-url` wires a proxy for the dev loop, and the same
 * option also configures `vite preview` — which would make the SPA and Blok one
 * origin and quietly turn this cell back into the in-project one (the preview
 * server would serve Blok's own shell). Turning it off is what makes the browser
 * talk to a SECOND origin, which is what scenario 14's CORS assertions are for.
 *
 * `tests/e2e/inertia/fixture.ts` copies this to the client root for standalone
 * cells only.
 */
export default defineConfig({
	plugins: [...react(), ...blokInertia({ proxy: false })] as UserConfig["plugins"],
});
