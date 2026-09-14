import { blokInertia } from "@blokjs/inertia-client/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig(({ isSsrBuild }) => ({
	plugins: [
		vue(),
		// Wraps the official `@inertiajs/vite` plugin: page resolution stays
		// upstream, this adds Blok's asset-version file, the `pages.json`
		// manifest and the dev proxy that forwards every non-asset request to
		// the Blok server.
		blokInertia({
			proxy: { target: "__BLOK_URL__" },
			ssr: __BLOK_SSR__,
		}),
	],
	build: isSsrBuild
		? {
				// `blokctl inertia start-ssr` looks for `client/dist-ssr/ssr.js`
				// first. Its own outDir also keeps `vite build --ssr` from
				// overwriting the client bundle.
				outDir: "dist-ssr",
				rollupOptions: { output: { entryFileNames: "ssr.js" } },
			}
		: // Default (hashed) filenames: the Blok shell reads them from the
			// `.blok-vite.json` descriptor blokInertia() writes, so nothing here
			// has to be predictable — and every deploy gets fresh, immutable URLs.
			{},
}));
