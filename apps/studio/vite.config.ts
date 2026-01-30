import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import path from "node:path";

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
          "graph": ["@xyflow/react", "dagre"],
          "charts": ["recharts"],
          "icons": ["lucide-react"],
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
      },
    },
  },
});
