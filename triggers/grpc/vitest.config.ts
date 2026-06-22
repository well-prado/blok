import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		coverage: {
			provider: "istanbul",
			reporter: ["text", "json", "html", "lcov"],
			exclude: ["node_modules/", "dist/", "**/*.d.ts", "**/*.config.ts", "__tests__/", "src/gen/", "src/types/"],
			thresholds: {
				lines: 86,
				functions: 90,
				branches: 70,
				statements: 86,
			},
		},
		include: ["__tests__/**/*.test.ts"],
		exclude: ["node_modules", "dist"],
		testTimeout: 10000,
		hookTimeout: 10000,
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
});
