import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		pool: "forks",
		maxWorkers: 3,
		minWorkers: 1,
		testTimeout: 15_000,
		hookTimeout: 15_000,
	},
});
