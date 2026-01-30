import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html", "lcov"],
			exclude: ["node_modules/", "dist/", "test/", "**/*.d.ts", "**/*.config.ts", "**/proto/**", "**/__tests__/**"],
			thresholds: {
				lines: 90,
				functions: 90,
				branches: 85,
				statements: 90,
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
