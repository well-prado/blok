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
