import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetEnvAllowlistForTests, getEnvForCtx } from "../../../src/utils/envAllowlist";

describe("envAllowlist", () => {
	// Capture the env BEFORE each test, with the allowlist keys explicitly
	// cleared so a leaky CI machine config can't make tests flaky.
	const originalEnv: NodeJS.ProcessEnv = (() => {
		const snapshot = { ...process.env };
		snapshot.BLOK_NODE_ENV_ALLOW = undefined;
		snapshot.BLOK_NODE_ENV_ALLOW_PREFIX = undefined;
		snapshot.BLOK_SUPPRESS_ENV_ALLOW_WARNING = undefined;
		return snapshot;
	})();

	beforeEach(() => {
		process.env = { ...originalEnv };
		_resetEnvAllowlistForTests();
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	describe("default-allow (no env vars set)", () => {
		it("returns process.env directly when neither allowlist is set", () => {
			process.env.SOME_KEY = "secret-value";
			const env = getEnvForCtx();
			expect(env.SOME_KEY).toBe("secret-value");
			// Identity check: returned object IS process.env, not a Proxy.
			expect(env).toBe(process.env);
		});

		it("preserves NODE_ENV and other process-supplied vars", () => {
			const env = getEnvForCtx();
			expect(env.PATH).toBeDefined();
		});
	});

	describe("BLOK_NODE_ENV_ALLOW (exact-match allowlist)", () => {
		it("exposes only the named keys", () => {
			process.env.PUBLIC_KEY = "ok";
			process.env.SECRET_KEY = "hidden";
			process.env.BLOK_NODE_ENV_ALLOW = "PUBLIC_KEY";

			const env = getEnvForCtx();
			expect(env.PUBLIC_KEY).toBe("ok");
			expect(env.SECRET_KEY).toBeUndefined();
		});

		it("supports multiple comma-separated names", () => {
			process.env.A = "1";
			process.env.B = "2";
			process.env.C = "3";
			process.env.BLOK_NODE_ENV_ALLOW = "A,C";

			const env = getEnvForCtx();
			expect(env.A).toBe("1");
			expect(env.B).toBeUndefined();
			expect(env.C).toBe("3");
		});

		it("trims whitespace around names", () => {
			process.env.NEEDED = "yes";
			process.env.BLOK_NODE_ENV_ALLOW = "  NEEDED  ,  ";

			const env = getEnvForCtx();
			expect(env.NEEDED).toBe("yes");
		});

		it("filters Object.keys to only allowed names", () => {
			process.env.ALLOWED = "1";
			process.env.DENIED = "2";
			process.env.BLOK_NODE_ENV_ALLOW = "ALLOWED";

			const env = getEnvForCtx();
			const keys = Object.keys(env);
			expect(keys).toContain("ALLOWED");
			expect(keys).not.toContain("DENIED");
		});

		it("filters `in` operator", () => {
			process.env.ALLOWED = "1";
			process.env.DENIED = "2";
			process.env.BLOK_NODE_ENV_ALLOW = "ALLOWED";

			const env = getEnvForCtx();
			expect("ALLOWED" in env).toBe(true);
			expect("DENIED" in env).toBe(false);
		});

		it("filters Object.entries", () => {
			process.env.ALLOWED = "1";
			process.env.DENIED = "2";
			process.env.BLOK_NODE_ENV_ALLOW = "ALLOWED";

			const env = getEnvForCtx();
			const entries = Object.entries(env);
			expect(entries.find(([k]) => k === "ALLOWED")).toBeDefined();
			expect(entries.find(([k]) => k === "DENIED")).toBeUndefined();
		});
	});

	describe("BLOK_NODE_ENV_ALLOW_PREFIX (prefix allowlist)", () => {
		it("exposes keys matching any prefix", () => {
			process.env.PUBLIC_A = "a";
			process.env.PUBLIC_B = "b";
			process.env.SECRET = "x";
			process.env.BLOK_NODE_ENV_ALLOW_PREFIX = "PUBLIC_";

			const env = getEnvForCtx();
			expect(env.PUBLIC_A).toBe("a");
			expect(env.PUBLIC_B).toBe("b");
			expect(env.SECRET).toBeUndefined();
		});

		it("supports multiple comma-separated prefixes", () => {
			process.env.PUB_A = "1";
			process.env.SAFE_B = "2";
			process.env.HIDDEN = "3";
			process.env.BLOK_NODE_ENV_ALLOW_PREFIX = "PUB_,SAFE_";

			const env = getEnvForCtx();
			expect(env.PUB_A).toBe("1");
			expect(env.SAFE_B).toBe("2");
			expect(env.HIDDEN).toBeUndefined();
		});
	});

	describe("combining exact + prefix allowlists", () => {
		it("allows keys matching either", () => {
			process.env.SPECIFIC_NAME = "exact";
			process.env.PUBLIC_X = "by-prefix";
			process.env.OTHER = "denied";
			process.env.BLOK_NODE_ENV_ALLOW = "SPECIFIC_NAME";
			process.env.BLOK_NODE_ENV_ALLOW_PREFIX = "PUBLIC_";

			const env = getEnvForCtx();
			expect(env.SPECIFIC_NAME).toBe("exact");
			expect(env.PUBLIC_X).toBe("by-prefix");
			expect(env.OTHER).toBeUndefined();
		});
	});

	describe("production warning", () => {
		it("warns once when BLOK_ENV=production and no allowlist is set", () => {
			process.env.BLOK_ENV = "production";
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

			getEnvForCtx();
			getEnvForCtx();
			getEnvForCtx();

			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0][0]).toContain("BLOK_ENV=production");
			expect(warn.mock.calls[0][0]).toContain("BLOK_NODE_ENV_ALLOW");
			warn.mockRestore();
		});

		it("does not warn when allowlist is configured (production)", () => {
			process.env.BLOK_ENV = "production";
			process.env.BLOK_NODE_ENV_ALLOW = "API_KEY";
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

			getEnvForCtx();

			expect(warn).not.toHaveBeenCalled();
			warn.mockRestore();
		});

		it("does not warn outside production (default)", () => {
			process.env.BLOK_ENV = undefined;
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

			getEnvForCtx();

			expect(warn).not.toHaveBeenCalled();
			warn.mockRestore();
		});

		it("BLOK_SUPPRESS_ENV_ALLOW_WARNING=1 silences the warning", () => {
			process.env.BLOK_ENV = "production";
			process.env.BLOK_SUPPRESS_ENV_ALLOW_WARNING = "1";
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

			getEnvForCtx();

			expect(warn).not.toHaveBeenCalled();
			warn.mockRestore();
		});
	});

	describe("edge cases", () => {
		it("symbol keys return undefined", () => {
			process.env.A = "1";
			process.env.BLOK_NODE_ENV_ALLOW = "A";

			const env = getEnvForCtx();
			const sym = Symbol("test");
			expect((env as unknown as Record<symbol, unknown>)[sym]).toBeUndefined();
		});

		it("empty allowlist string is treated as no allowlist", () => {
			process.env.SECRET = "still-visible";
			process.env.BLOK_NODE_ENV_ALLOW = "";

			const env = getEnvForCtx();
			// Empty string parses to empty list → no config → default-allow.
			expect(env.SECRET).toBe("still-visible");
			expect(env).toBe(process.env);
		});

		it("re-reads config on each call (no module-level caching)", () => {
			process.env.A = "value";

			process.env.BLOK_NODE_ENV_ALLOW = "A";
			expect(getEnvForCtx().A).toBe("value");

			process.env.BLOK_NODE_ENV_ALLOW = "B";
			expect(getEnvForCtx().A).toBeUndefined();
		});
	});
});
