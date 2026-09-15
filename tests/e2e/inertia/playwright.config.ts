import { defineConfig, devices } from "playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "conformance.spec.ts",
	fullyParallel: false,
	retries: process.env.CI ? 2 : 0,
	workers: 1,
	use: {
		baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:4000",
		trace: "retain-on-failure",
		headless: true,
		...devices["Desktop Chrome"],
	},
	reporter: process.env.CI ? [["line"], ["html", { outputFolder: "test-results/inertia-report" }]] : "line",
});
