import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		coverage: {
			provider: "istanbul",
			reporter: ["text", "json", "html", "lcov"],
			exclude: [
				"node_modules/",
				"dist/",
				"**/*.d.ts",
				"**/*.config.ts",
				"__tests__/",
				"src/nodes/",
				"src/workflows/",
				"src/runner/types/",
				"src/runner/metrics/",
			],
			thresholds: {
				lines: 68,
				functions: 58,
				branches: 60,
				statements: 68,
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
