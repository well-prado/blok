import { describe, expect, it, vi } from "vitest";
import { normalizeProjectConfig } from "../../src/services/runtime-setup";

describe("project JavaScript runtime configuration", () => {
	it("defaults old config without runtime to the legacy-compatible shape", () => {
		const config = { packageManager: "npm" as const };

		expect(normalizeProjectConfig(config)).toEqual(config);
	});

	it("normalizes nodejs config aliases and preserves package-manager policy", () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const normalized = normalizeProjectConfig({ runtime: "nodejs", packageManager: "bun" });

		expect(normalized).toEqual({ runtime: "node", packageManager: "bun" });
		expect(warning).toHaveBeenCalledWith(expect.stringContaining('use "node"'));
		warning.mockRestore();
	});

	it("keeps Bun and Deno distinct from the Node.js compatibility alias", () => {
		expect(normalizeProjectConfig({ runtime: "bun" }).runtime).toBe("bun");
		expect(normalizeProjectConfig({ runtime: "deno" }).runtime).toBe("deno");
	});
});
