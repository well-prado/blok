import { describe, expect, it } from "vitest";
import {
	compareSemver,
	computeDefaultConstraint,
	formatVersionMismatch,
	formatVersionSuccess,
	parseConstraint,
	parseSemver,
	satisfiesConstraint,
	semverGte,
} from "./semver-utils.js";

describe("parseSemver", () => {
	it("parses a full semver string", () => {
		expect(parseSemver("3.12.0")).toEqual({ major: 3, minor: 12, patch: 0 });
	});

	it("parses a two-part version", () => {
		expect(parseSemver("1.22")).toEqual({ major: 1, minor: 22, patch: 0 });
	});

	it("parses a single-part version", () => {
		expect(parseSemver("17")).toEqual({ major: 17, minor: 0, patch: 0 });
	});

	it("handles 0.x versions", () => {
		expect(parseSemver("0.2.3")).toEqual({ major: 0, minor: 2, patch: 3 });
		expect(parseSemver("0.0.3")).toEqual({ major: 0, minor: 0, patch: 3 });
	});

	it("handles large version numbers", () => {
		expect(parseSemver("17.0.11")).toEqual({ major: 17, minor: 0, patch: 11 });
	});

	it("trims whitespace", () => {
		expect(parseSemver("  3.12.0  ")).toEqual({ major: 3, minor: 12, patch: 0 });
	});
});

describe("compareSemver", () => {
	it("returns 0 for equal versions", () => {
		expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
	});

	it("returns positive when a > b (major)", () => {
		expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
	});

	it("returns positive when a > b (minor)", () => {
		expect(compareSemver("1.3.0", "1.2.9")).toBeGreaterThan(0);
	});

	it("returns positive when a > b (patch)", () => {
		expect(compareSemver("1.2.4", "1.2.3")).toBeGreaterThan(0);
	});

	it("returns negative when a < b", () => {
		expect(compareSemver("1.2.3", "1.2.4")).toBeLessThan(0);
	});

	it("treats missing patch as 0", () => {
		expect(compareSemver("1.22", "1.22.0")).toBe(0);
	});
});

describe("semverGte", () => {
	it("returns true for equal versions", () => {
		expect(semverGte({ major: 3, minor: 10, patch: 0 }, { major: 3, minor: 10, patch: 0 })).toBe(true);
	});

	it("returns true when major is greater", () => {
		expect(semverGte({ major: 4, minor: 0, patch: 0 }, { major: 3, minor: 10, patch: 0 })).toBe(true);
	});

	it("returns true when minor is greater", () => {
		expect(semverGte({ major: 3, minor: 11, patch: 0 }, { major: 3, minor: 10, patch: 0 })).toBe(true);
	});

	it("returns true when patch is greater", () => {
		expect(semverGte({ major: 3, minor: 10, patch: 1 }, { major: 3, minor: 10, patch: 0 })).toBe(true);
	});

	it("returns false when less than", () => {
		expect(semverGte({ major: 3, minor: 9, patch: 7 }, { major: 3, minor: 10, patch: 0 })).toBe(false);
	});
});

describe("parseConstraint", () => {
	it("parses >= operator", () => {
		const result = parseConstraint(">=3.10.0");
		expect(result.operator).toBe(">=");
		expect(result.version).toBe("3.10.0");
		expect(result.parts).toEqual({ major: 3, minor: 10, patch: 0 });
	});

	it("parses ^ operator", () => {
		const result = parseConstraint("^1.22.0");
		expect(result.operator).toBe("^");
		expect(result.version).toBe("1.22.0");
	});

	it("parses ~ operator", () => {
		const result = parseConstraint("~1.22.0");
		expect(result.operator).toBe("~");
		expect(result.version).toBe("1.22.0");
	});

	it("parses exact version (no operator)", () => {
		const result = parseConstraint("3.12.0");
		expect(result.operator).toBe("");
		expect(result.version).toBe("3.12.0");
	});

	it("parses = operator", () => {
		const result = parseConstraint("=3.12.0");
		expect(result.operator).toBe("=");
		expect(result.version).toBe("3.12.0");
	});

	it("trims whitespace", () => {
		const result = parseConstraint("  >=3.10.0  ");
		expect(result.operator).toBe(">=");
		expect(result.version).toBe("3.10.0");
	});
});

describe("satisfiesConstraint", () => {
	describe(">= operator", () => {
		it("satisfies when equal", () => {
			expect(satisfiesConstraint("3.10.0", ">=3.10.0")).toBe(true);
		});

		it("satisfies when greater (patch)", () => {
			expect(satisfiesConstraint("3.10.1", ">=3.10.0")).toBe(true);
		});

		it("satisfies when greater (minor)", () => {
			expect(satisfiesConstraint("3.11.0", ">=3.10.0")).toBe(true);
		});

		it("satisfies when greater (major)", () => {
			expect(satisfiesConstraint("4.0.0", ">=3.10.0")).toBe(true);
		});

		it("fails when less than (minor)", () => {
			expect(satisfiesConstraint("3.9.7", ">=3.10.0")).toBe(false);
		});

		it("fails when less than (major)", () => {
			expect(satisfiesConstraint("2.99.99", ">=3.10.0")).toBe(false);
		});

		// Real-world Python scenario
		it("Python 3.12.0 satisfies >=3.10.0", () => {
			expect(satisfiesConstraint("3.12.0", ">=3.10.0")).toBe(true);
		});

		it("Python 3.9.7 does not satisfy >=3.10.0", () => {
			expect(satisfiesConstraint("3.9.7", ">=3.10.0")).toBe(false);
		});

		// Real-world Go scenario
		it("Go 1.22.5 satisfies >=1.21.0", () => {
			expect(satisfiesConstraint("1.22.5", ">=1.21.0")).toBe(true);
		});

		// Real-world Java scenario
		it("Java 17.0.11 satisfies >=17.0.0", () => {
			expect(satisfiesConstraint("17.0.11", ">=17.0.0")).toBe(true);
		});

		it("Java 11.0.2 does not satisfy >=17.0.0", () => {
			expect(satisfiesConstraint("11.0.2", ">=17.0.0")).toBe(false);
		});
	});

	describe("^ (caret) operator", () => {
		it("satisfies when equal", () => {
			expect(satisfiesConstraint("1.22.0", "^1.22.0")).toBe(true);
		});

		it("satisfies when patch is higher", () => {
			expect(satisfiesConstraint("1.22.5", "^1.22.0")).toBe(true);
		});

		it("satisfies when minor is higher", () => {
			expect(satisfiesConstraint("1.23.0", "^1.22.0")).toBe(true);
		});

		it("fails when major is different", () => {
			expect(satisfiesConstraint("2.0.0", "^1.22.0")).toBe(false);
		});

		it("fails when version is lower", () => {
			expect(satisfiesConstraint("1.21.9", "^1.22.0")).toBe(false);
		});

		// 0.x special handling
		it("^0.2.3 requires minor match", () => {
			expect(satisfiesConstraint("0.2.3", "^0.2.3")).toBe(true);
			expect(satisfiesConstraint("0.2.4", "^0.2.3")).toBe(true);
			expect(satisfiesConstraint("0.3.0", "^0.2.3")).toBe(false);
		});

		it("^0.0.3 requires exact patch match", () => {
			expect(satisfiesConstraint("0.0.3", "^0.0.3")).toBe(true);
			expect(satisfiesConstraint("0.0.4", "^0.0.3")).toBe(false);
		});
	});

	describe("~ (tilde) operator", () => {
		it("satisfies when equal", () => {
			expect(satisfiesConstraint("1.22.0", "~1.22.0")).toBe(true);
		});

		it("satisfies when patch is higher", () => {
			expect(satisfiesConstraint("1.22.5", "~1.22.0")).toBe(true);
		});

		it("fails when minor is different", () => {
			expect(satisfiesConstraint("1.23.0", "~1.22.0")).toBe(false);
		});

		it("fails when major is different", () => {
			expect(satisfiesConstraint("2.22.0", "~1.22.0")).toBe(false);
		});

		it("fails when patch is lower", () => {
			expect(satisfiesConstraint("1.22.0", "~1.22.3")).toBe(false);
		});
	});

	describe("exact version", () => {
		it("satisfies when exact match", () => {
			expect(satisfiesConstraint("3.12.0", "3.12.0")).toBe(true);
		});

		it("fails when patch differs", () => {
			expect(satisfiesConstraint("3.12.1", "3.12.0")).toBe(false);
		});

		it("fails when minor differs", () => {
			expect(satisfiesConstraint("3.13.0", "3.12.0")).toBe(false);
		});

		it("works with = prefix", () => {
			expect(satisfiesConstraint("3.12.0", "=3.12.0")).toBe(true);
			expect(satisfiesConstraint("3.12.1", "=3.12.0")).toBe(false);
		});
	});
});

describe("computeDefaultConstraint", () => {
	it("computes >=major.minor.0 from full version", () => {
		expect(computeDefaultConstraint("3.12.4")).toBe(">=3.12.0");
	});

	it("computes >=major.minor.0 when patch is already 0", () => {
		expect(computeDefaultConstraint("1.22.0")).toBe(">=1.22.0");
	});

	it("handles two-part version", () => {
		expect(computeDefaultConstraint("1.22")).toBe(">=1.22.0");
	});

	it("handles large major version (Java)", () => {
		expect(computeDefaultConstraint("17.0.11")).toBe(">=17.0.0");
	});

	it("handles 0.x versions", () => {
		expect(computeDefaultConstraint("0.2.3")).toBe(">=0.2.0");
	});
});

describe("formatVersionMismatch", () => {
	it("formats a mismatch with install hint", () => {
		const result = formatVersionMismatch(
			"Python 3",
			"3.9.7",
			">=3.10.0",
			"Install Python 3.10+: https://python.org/downloads/",
		);
		expect(result).toContain("x Python 3");
		expect(result).toContain("Required: >=3.10.0");
		expect(result).toContain("Found:    3.9.7");
		expect(result).toContain("Fix:      Install Python 3.10+");
		expect(result).toContain("Or update constraint in .blok/config.json");
	});

	it("formats a mismatch when not installed", () => {
		const result = formatVersionMismatch("Go", undefined, ">=1.22.0", "Install Go: https://go.dev/dl/");
		expect(result).toContain("Found:    not installed");
	});

	it("formats without install hint", () => {
		const result = formatVersionMismatch("Rust", "1.70.0", ">=1.75.0");
		expect(result).not.toContain("Fix:");
		expect(result).toContain("Or update constraint");
	});
});

describe("formatVersionSuccess", () => {
	it("formats a success message", () => {
		const result = formatVersionSuccess("Python 3", "3.12.0", ">=3.10.0");
		expect(result).toContain("✓");
		expect(result).toContain("Python 3");
		expect(result).toContain("3.12.0");
		expect(result).toContain("requires >=3.10.0");
	});
});
