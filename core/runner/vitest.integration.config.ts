import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",

		// Integration tests need longer timeouts
		testTimeout: 60000, // 60s for Docker operations
		hookTimeout: 30000, // 30s for setup/teardown

		// Only run integration tests
		include: ["__tests__/integration/**/*.integration.test.ts"],
		exclude: ["node_modules", "dist", "__tests__/unit/**"],

		// Run tests sequentially for Docker/resource management
		pool: "forks",
		poolOptions: {
			forks: {
				singleFork: true, // Run tests in single process for Docker stability
			},
		},

		coverage: {
			provider: "istanbul",
			reporter: ["text", "json", "html"],
			include: ["src/**/*.ts"],
			exclude: ["node_modules/", "dist/", "test/", "**/*.d.ts", "**/*.config.ts", "**/proto/**", "**/__tests__/**"],
		},

		// Setup file for integration tests
		setupFiles: ["./__tests__/integration/setup.ts"],
	},

	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			"@test": path.resolve(__dirname, "./__tests__"),
			"@integration": path.resolve(__dirname, "./__tests__/integration"),
		},
	},
});
