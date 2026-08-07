import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
	test: {
		environment: "jsdom",
		globals: true,
		setupFiles: ["./src/__tests__/setup.ts"],
		include: ["src/**/*.test.{ts,tsx}"],
	},
});
