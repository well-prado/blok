import path from "node:path";
import { defineConfig, devices } from "playwright/test";

const repoRoot = path.resolve(process.cwd());
const cellId = process.env.E2E_CELL_ID ?? "manual";
const runNumber = process.env.E2E_RUN_NUMBER ?? "1";
const resultRoot = path.join(repoRoot, "test-results", "inertia", cellId, `run-${runNumber}`);

export default defineConfig({
	testDir: ".",
	testMatch: "conformance.spec.ts",
	fullyParallel: false,
	retries: 0,
	workers: 1,
	outputDir: resultRoot,
	use: {
		baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:4000",
		trace: "retain-on-failure",
		headless: true,
		...devices["Desktop Chrome"],
	},
	reporter: process.env.CI ? [["line"], ["html", { outputFolder: path.join(resultRoot, "html-report") }]] : "line",
});
