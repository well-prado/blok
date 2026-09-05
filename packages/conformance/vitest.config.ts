import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
	resolve: {
		alias: {
			"@blokjs/agent-kernel": path.resolve(__dirname, "../agent-kernel/src/index.ts"),
			"@blokjs/capabilities": path.resolve(__dirname, "../capabilities/src/index.ts"),
			"@blokjs/code-mode": path.resolve(__dirname, "../code-mode/src/index.ts"),
			"@blokjs/helper": path.resolve(__dirname, "../../core/workflow-helper/src/index.ts"),
			"@blokjs/runner": path.resolve(__dirname, "../../core/runner/src/index.ts"),
			"@blokjs/shared": path.resolve(__dirname, "../../core/shared/src/index.ts"),
		},
	},
});
