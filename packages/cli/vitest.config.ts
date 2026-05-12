import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// `CompilationValidator.test.ts` runs `ts.createProgram()` 6× with
		// `getSemanticDiagnostics()` — heavy on a cold CI runner because
		// the type checker has to walk the standard library on the first
		// call. Observed timing out at the default 5s on GitHub Actions
		// (passes locally < 1s). 30s applies to every test in the package
		// — overkill for the fast ones but harmless; only matters for the
		// slow CompilationValidator family.
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
