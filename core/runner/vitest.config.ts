import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		coverage: {
			provider: "istanbul",
			reporter: ["text", "json", "html", "lcov"],
			exclude: ["node_modules/", "dist/", "test/", "**/*.d.ts", "**/*.config.ts", "**/proto/**", "**/__tests__/**"],
			thresholds: {
				lines: 78,
				functions: 77,
				branches: 66,
				statements: 76,
			},
		},
		include: ["src/**/__tests__/**/*.test.ts", "test/**/*.test.ts", "__tests__/**/*.test.ts"],
		exclude: ["node_modules", "dist"],
		testTimeout: 10000,
		hookTimeout: 10000,
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			"@test": path.resolve(__dirname, "./test"),
		},
	},
});
