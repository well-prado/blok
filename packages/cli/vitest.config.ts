import { configDefaults, defineConfig } from "vitest/config";

const bunScaffold = "tests/commands/create/project-non-interactive.test.ts";

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
		// One Bun install cache per worker: concurrent scaffold installs of the
		// same `file:` dependency race on the shared global cache (see setup file).
		setupFiles: ["./tests/setup/isolate-bun-cache.ts"],
		projects: [
			{
				extends: true,
				test: { name: "cli", exclude: [...configDefaults.exclude, bunScaffold] },
			},
			{
				extends: true,
				test: {
					name: "bun-scaffold",
					include: [bunScaffold],
					fileParallelism: false,
					// Wait for sibling workers to stop mutating the file: source (#1030).
					sequence: { groupOrder: 1 },
				},
			},
		],
	},
});
