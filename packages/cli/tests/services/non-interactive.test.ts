import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isNonInteractive,
	parseCommaSeparated,
	resolveOrThrow,
	setNonInteractive,
	validateChoice,
} from "../../src/services/non-interactive.js";

describe("non-interactive service", () => {
	beforeEach(() => {
		setNonInteractive(false);
		process.env.BLOK_NON_INTERACTIVE = undefined;
	});

	afterEach(() => {
		setNonInteractive(false);
		process.env.BLOK_NON_INTERACTIVE = undefined;
	});

	describe("isNonInteractive", () => {
		it("returns false by default", () => {
			expect(isNonInteractive()).toBe(false);
		});

		it("returns true after setNonInteractive(true)", () => {
			setNonInteractive(true);
			expect(isNonInteractive()).toBe(true);
		});

		it("returns true when BLOK_NON_INTERACTIVE=1", () => {
			process.env.BLOK_NON_INTERACTIVE = "1";
			expect(isNonInteractive()).toBe(true);
		});

		it("returns false when BLOK_NON_INTERACTIVE is not 1", () => {
			process.env.BLOK_NON_INTERACTIVE = "0";
			expect(isNonInteractive()).toBe(false);
		});

		it("returns false after setNonInteractive(false)", () => {
			setNonInteractive(true);
			setNonInteractive(false);
			expect(isNonInteractive()).toBe(false);
		});
	});

	describe("resolveOrThrow", () => {
		it("returns flag value when provided", () => {
			setNonInteractive(true);
			expect(resolveOrThrow("name", "my-value")).toBe("my-value");
		});

		it("returns default value when flag is undefined", () => {
			setNonInteractive(true);
			expect(resolveOrThrow("name", undefined, "default-value")).toBe("default-value");
		});

		it("throws in non-interactive mode when no flag or default", () => {
			setNonInteractive(true);
			expect(() => resolveOrThrow("name", undefined)).toThrow("Missing required flag --name (non-interactive mode)");
		});

		it("returns undefined in interactive mode when no flag or default", () => {
			setNonInteractive(false);
			expect(resolveOrThrow("name", undefined)).toBeUndefined();
		});

		it("prefers flag value over default", () => {
			expect(resolveOrThrow("name", "flag-value", "default-value")).toBe("flag-value");
		});

		it("handles false-y but defined flag values", () => {
			expect(resolveOrThrow("flag", 0)).toBe(0);
			expect(resolveOrThrow("flag", "")).toBe("");
			expect(resolveOrThrow("flag", false)).toBe(false);
		});
	});

	describe("validateChoice", () => {
		const allowed = ["npm", "yarn", "pnpm", "bun"] as const;

		it("returns valid choice", () => {
			expect(validateChoice("pm", "npm", allowed)).toBe("npm");
		});

		it("throws for invalid choice", () => {
			expect(() => validateChoice("pm", "invalid" as any, allowed)).toThrow(
				'Invalid value "invalid" for --pm. Allowed: npm, yarn, pnpm, bun',
			);
		});
	});

	describe("parseCommaSeparated", () => {
		it("parses simple comma-separated string", () => {
			expect(parseCommaSeparated("node,python3")).toEqual(["node", "python3"]);
		});

		it("trims whitespace", () => {
			expect(parseCommaSeparated("node , python3 , go")).toEqual(["node", "python3", "go"]);
		});

		it("filters empty strings", () => {
			expect(parseCommaSeparated("node,,python3,")).toEqual(["node", "python3"]);
		});

		it("handles single value", () => {
			expect(parseCommaSeparated("node")).toEqual(["node"]);
		});
	});
});
