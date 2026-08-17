import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [TanStackRouterVite({ quoteStyle: "double" }), react(), tailwindcss()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			// #691 — ONE implementation of the ref validator, shared with blokctl
			// and the runner. Aliased to source (not a package dependency) so the
			// browser bundle takes the zero-dependency module and never the Zod
			// schema graph ADR 0011 measured at +24.5 kB gzip.
			"@blok/validate-refs": path.resolve(__dirname, "../../core/workflow-helper/src/validateRefs.ts"),
		},
	},
	build: {
		rollupOptions: {
			output: {
				manualChunks: {
					"react-vendor": ["react", "react-dom"],
					"tanstack-router": ["@tanstack/react-router"],
					"tanstack-query": ["@tanstack/react-query"],
					"tanstack-table": ["@tanstack/react-table"],
					radix: [
						"@radix-ui/react-tooltip",
						"@radix-ui/react-dialog",
						"@radix-ui/react-popover",
						"@radix-ui/react-dropdown-menu",
						"@radix-ui/react-switch",
					],
					graph: ["@xyflow/react", "dagre"],
					charts: ["recharts"],
					icons: ["lucide-react"],
				},
			},
		},
	},
	server: {
		port: 5555,
		proxy: {
			"/__blok": {
				target: "http://localhost:4000",
				changeOrigin: true,
				ws: true,
				// Prevent proxy from timing out long-lived SSE connections
				timeout: 0,
				configure: (proxy) => {
					proxy.on("proxyRes", (proxyRes) => {
						// Disable buffering for SSE streams
						if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
							proxyRes.headers["cache-control"] = "no-cache";
							proxyRes.headers["x-accel-buffering"] = "no";
						}
					});
				},
			},
		},
	},
});
