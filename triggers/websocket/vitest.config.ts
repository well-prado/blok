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
				lines: 60,
				functions: 63,
				branches: 48,
				statements: 58,
			},
		},
		include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
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
