import { describe, expect, it } from "vitest";
import {
	type MinimalPkg,
	checkCliConstants,
	checkCrossDepRanges,
	checkLockstepVersion,
	floatingVersions,
	rangeIncludesVersion,
} from "../../../scripts/release-preflight";

/**
 * #381 — pre-flight is pure functions over package.json inputs, unit-tested
 * without touching npm/git. After #380 (@blokjs/core floats independently of the
 * lockstep surface), these guard the hybrid: core-major drift FAILS, an in-range
 * core+trigger PASSES, and the semver-ish range matcher's behavior on forms it
 * does NOT model is explicit, not silent.
 */

const pkg = (name: string, version: string, deps?: Record<string, string>): MinimalPkg => ({
	name,
	version,
	...(deps ? { dependencies: deps } : {}),
});

describe("checkLockstepVersion — @blokjs/core excluded from lockstep", () => {
	it("passes when every non-floating package shares one version", () => {
		const r = checkLockstepVersion([pkg("@blokjs/runner", "1.1.0"), pkg("@blokjs/trigger-http", "1.1.0")]);
		expect(r.failures).toEqual([]);
		expect(r.version).toBe("1.1.0");
	});

	it("ignores @blokjs/core's version — core may float above the lockstep", () => {
		const r = checkLockstepVersion([
			pkg("@blokjs/runner", "1.1.0"),
			pkg("@blokjs/trigger-http", "1.1.0"),
			pkg("@blokjs/core", "1.4.0"), // floats — must NOT trip the lockstep check
		]);
		expect(r.failures).toEqual([]);
		expect(r.version).toBe("1.1.0");
	});

	it("fails when two lockstep packages disagree", () => {
		const r = checkLockstepVersion([pkg("@blokjs/runner", "1.1.0"), pkg("@blokjs/trigger-http", "1.2.0")]);
		expect(r.version).toBeNull();
		expect(r.failures[0].category).toBe("version");
		expect(r.failures[0].detail).toMatch(/lockstep violated/);
	});
});

describe("floatingVersions", () => {
	it("extracts @blokjs/core's independent version", () => {
		const m = floatingVersions([pkg("@blokjs/runner", "1.1.0"), pkg("@blokjs/core", "1.4.0")]);
		expect(m.get("@blokjs/core")).toBe("1.4.0");
		expect(m.size).toBe(1);
	});
});

describe("rangeIncludesVersion — real caret/tilde semantics + conservative reject", () => {
	it("exact match", () => {
		expect(rangeIncludesVersion("1.1.0", "1.1.0")).toBe(true);
		expect(rangeIncludesVersion("1.1.0", "1.1.1")).toBe(false);
	});
	it("caret admits in-major bumps, rejects major drift + below-base", () => {
		expect(rangeIncludesVersion("^1.1.0", "1.1.0")).toBe(true);
		expect(rangeIncludesVersion("^1.1.0", "1.2.0")).toBe(true); // core minor bump
		expect(rangeIncludesVersion("^1.1.0", "2.0.0")).toBe(false); // major drift
		expect(rangeIncludesVersion("^1.1.0", "1.0.9")).toBe(false); // below base
	});
	it("caret 0.x pins the minor", () => {
		expect(rangeIncludesVersion("^0.6.1", "0.6.5")).toBe(true);
		expect(rangeIncludesVersion("^0.6.1", "0.7.0")).toBe(false);
		expect(rangeIncludesVersion("^0.6.1", "0.6.0")).toBe(false); // below base
	});
	it("tilde pins the minor", () => {
		expect(rangeIncludesVersion("~1.1.0", "1.1.5")).toBe(true);
		expect(rangeIncludesVersion("~1.1.0", "1.2.0")).toBe(false);
	});
	it("conservatively REJECTS forms it does not model (no silent pass)", () => {
		// #381: >=, ||, x-ranges, and prerelease versions are not modeled → false,
		// which surfaces as a loud pre-flight failure rather than slipping through.
		expect(rangeIncludesVersion(">=1.0.0", "1.2.0")).toBe(false);
		expect(rangeIncludesVersion("1.x", "1.2.0")).toBe(false);
		expect(rangeIncludesVersion("1.1.0 || 2.0.0", "2.0.0")).toBe(false);
		expect(rangeIncludesVersion("^1.2.0", "1.2.0-rc.1")).toBe(false); // prerelease excluded
	});
});

describe("checkCrossDepRanges — core-aware (#380/#381)", () => {
	const published = ["@blokjs/core", "@blokjs/runner"];

	it("PASS: core floats to 1.2.0, a trigger pins @blokjs/core ^1.0.0", () => {
		const floating = new Map([["@blokjs/core", "1.2.0"]]);
		const f = checkCrossDepRanges("1.1.0", floating, published, [
			{ rel: "triggers/http/package.json", pkg: pkg("@blokjs/trigger-http", "1.1.0", { "@blokjs/core": "^1.0.0" }) },
		]);
		expect(f).toEqual([]);
	});

	it("FAIL: core at 2.0.0 but a trigger pins @blokjs/core ^1.0.0 (major drift)", () => {
		const floating = new Map([["@blokjs/core", "2.0.0"]]);
		const f = checkCrossDepRanges("1.1.0", floating, published, [
			{ rel: "triggers/http/package.json", pkg: pkg("@blokjs/trigger-http", "1.1.0", { "@blokjs/core": "^1.0.0" }) },
		]);
		expect(f).toHaveLength(1);
		expect(f[0].detail).toMatch(/@blokjs\/core has range "\^1\.0\.0" but it ships at 2\.0\.0/);
	});

	it("validates lockstep deps against the lockstep version, not core's", () => {
		const floating = new Map([["@blokjs/core", "1.2.0"]]);
		const f = checkCrossDepRanges("1.1.0", floating, published, [
			{ rel: "triggers/http/package.json", pkg: pkg("@blokjs/trigger-http", "1.1.0", { "@blokjs/runner": "^1.1.0" }) },
		]);
		expect(f).toEqual([]);
	});

	it("skips workspace:* / * and non-published deps", () => {
		const floating = new Map<string, string>();
		const f = checkCrossDepRanges("1.1.0", floating, published, [
			{
				rel: "a/package.json",
				pkg: pkg("a", "1.1.0", { "@blokjs/runner": "workspace:*", "@blokjs/core": "*", zod: "^3.0.0" }),
			},
		]);
		expect(f).toEqual([]);
	});
});

describe("checkCliConstants — scaffold range must admit lockstep AND floating core", () => {
	const src = (tag: string, range: string) =>
		`const GITHUB_REPO_RELEASE_TAG = "${tag}";\nconst BLOKJS_DEP_RANGE = "${range}";`;

	it("PASS: tag tracks lockstep, range admits lockstep + a floated core minor", () => {
		const floating = new Map([["@blokjs/core", "1.2.0"]]);
		expect(checkCliConstants("1.1.0", floating, src("v1.1.0", "^1.1.0"))).toEqual([]);
	});

	it("FAIL: core floats to a MAJOR the scaffold range can't admit", () => {
		const floating = new Map([["@blokjs/core", "2.0.0"]]);
		const f = checkCliConstants("1.1.0", floating, src("v1.1.0", "^1.1.0"));
		expect(f.some((x) => /BLOKJS_DEP_RANGE.*does not include 2\.0\.0/.test(x.detail))).toBe(true);
	});

	it("FAIL: release tag does not match the lockstep version", () => {
		const f = checkCliConstants("1.1.0", new Map(), src("v1.0.0", "^1.1.0"));
		expect(f.some((x) => /GITHUB_REPO_RELEASE_TAG.*but lockstep is v1\.1\.0/.test(x.detail))).toBe(true);
	});
});
