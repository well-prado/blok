/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
	packageManager: "pnpm",
	reporters: ["html", "clear-text", "progress", "dashboard"],
	testRunner: "vitest",
	vitest: {
		configFile: "core/runner/vitest.config.ts",
	},
	coverageAnalysis: "perTest",
	mutate: [
		"core/runner/src/**/*.ts",
		"!core/runner/src/**/*.test.ts",
		"!core/runner/src/**/*.spec.ts",
		"!core/runner/src/**/__tests__/**",
		"!core/runner/src/**/index.ts",
		"!core/runner/src/**/*.d.ts",
	],
	thresholds: {
		high: 80,
		low: 60,
		break: 50,
	},
	concurrency: 4,
	timeoutMS: 30000,
	tempDirName: ".stryker-tmp",
	cleanTempDir: "always",
	htmlReporter: {
		fileName: "reports/mutation/mutation-report.html",
	},
	dashboard: {
		project: "github.com/Deskree/blok",
		version: "main",
	},
};
