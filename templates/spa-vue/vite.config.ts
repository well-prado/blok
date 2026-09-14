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
				// overwriting the client bundle, which shares the name `app.js`.
				outDir: "dist-ssr",
				rollupOptions: { output: { entryFileNames: "ssr.js" } },
			}
		: {
				// ponytail: a FIXED entry filename, so the Blok HTML shell can
				// point at `/assets/app.js` without reading the Vite manifest.
				// Chunks and other assets stay fingerprinted. Read the manifest
				// instead if you ever need the entry itself content-hashed.
				rollupOptions: {
					output: {
						entryFileNames: "assets/app.js",
						chunkFileNames: "assets/[name]-[hash].js",
						assetFileNames: "assets/[name]-[hash][extname]",
					},
				},
			},
}));
