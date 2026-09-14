import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Rooted at the REPO, not at this directory, so one project covers both the
 * docs gates and the Inertia examples' own `runPage` suites — the examples are
 * not workspace packages (they resolve `@blokjs/*` through the root install),
 * so this is what makes their tests run in CI.
 */
export default defineConfig({
	test: {
		root: resolve(import.meta.dirname, "../.."),
		include: ["tests/docs/**/*.test.ts", "examples/inertia-*/**/tests/**/*.test.ts"],
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
