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
				lines: 90,
				functions: 90,
				branches: 85,
				statements: 90,
			},
		},
		include: ["src/**/__tests__/**/*.test.ts", "test/**/*.test.ts", "__tests__/**/*.test.ts"],
		// Integration tests (`*.integration.test.ts`) need the dedicated
		// `vitest.integration.config.ts` runner — that config uses
		// `pool: "forks"` with `singleFork: true` because spawning real
		// SDK binaries doesn't tolerate parallel test workers (port +
		// resource races). Excluding them here keeps `bun run test` fast
		// and reliable. Integration suite runs via `bun run test:integration`.
		exclude: ["node_modules", "dist", "__tests__/integration/**"],
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
