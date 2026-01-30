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
          "tanstack": ["@tanstack/react-router", "@tanstack/react-query", "@tanstack/react-table"],
          "graph": ["@xyflow/react", "dagre"],
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
