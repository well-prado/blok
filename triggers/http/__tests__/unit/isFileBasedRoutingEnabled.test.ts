import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isFileBasedRoutingEnabled } from "../../src/runner/HttpTrigger";

/**
 * v0.6 — file-based routing is the framework default. These tests pin
 * the env-flag matrix that decides whether `buildFileBasedRoutes` runs
 * or the trigger falls back to the deprecated catch-all.
 *
 * Matrix:
 *   - BLOK_FILE_BASED_ROUTING unset  + BLOK_ROUTING_LEGACY unset  → true (default)
 *   - BLOK_FILE_BASED_ROUTING=true   + BLOK_ROUTING_LEGACY unset  → true (explicit on)
 *   - BLOK_FILE_BASED_ROUTING=false  + BLOK_ROUTING_LEGACY unset  → false (explicit off)
 *   - BLOK_FILE_BASED_ROUTING unset  + BLOK_ROUTING_LEGACY=1      → false (legacy)
 *   - BLOK_FILE_BASED_ROUTING unset  + BLOK_ROUTING_LEGACY=true   → false (legacy alt syntax)
 *   - BLOK_FILE_BASED_ROUTING=true   + BLOK_ROUTING_LEGACY=1      → false (legacy wins)
 */
describe("isFileBasedRoutingEnabled (v0.6 default)", () => {
	const savedFbr = process.env.BLOK_FILE_BASED_ROUTING;
	const savedLegacy = process.env.BLOK_ROUTING_LEGACY;

	beforeEach(() => {
		// biome-ignore lint/performance/noDelete: tests need a literally-absent env var, not the string "undefined"
		delete process.env.BLOK_FILE_BASED_ROUTING;
		// biome-ignore lint/performance/noDelete: same as above
		delete process.env.BLOK_ROUTING_LEGACY;
	});

	afterEach(() => {
		if (savedFbr === undefined) {
			// biome-ignore lint/performance/noDelete: restore literal absence
			delete process.env.BLOK_FILE_BASED_ROUTING;
		} else {
			process.env.BLOK_FILE_BASED_ROUTING = savedFbr;
		}
		if (savedLegacy === undefined) {
			// biome-ignore lint/performance/noDelete: restore literal absence
			delete process.env.BLOK_ROUTING_LEGACY;
		} else {
			process.env.BLOK_ROUTING_LEGACY = savedLegacy;
		}
	});

	it("returns true when both env vars are unset (the v0.6 default)", () => {
		expect(isFileBasedRoutingEnabled()).toBe(true);
	});

	it("returns true with BLOK_FILE_BASED_ROUTING=true (explicit on)", () => {
		process.env.BLOK_FILE_BASED_ROUTING = "true";
		expect(isFileBasedRoutingEnabled()).toBe(true);
	});

	it("returns false with BLOK_FILE_BASED_ROUTING=false (explicit kill switch)", () => {
		process.env.BLOK_FILE_BASED_ROUTING = "false";
		expect(isFileBasedRoutingEnabled()).toBe(false);
	});

	it("returns false with BLOK_ROUTING_LEGACY=1 (full legacy mode)", () => {
		process.env.BLOK_ROUTING_LEGACY = "1";
		expect(isFileBasedRoutingEnabled()).toBe(false);
	});

	it("returns false with BLOK_ROUTING_LEGACY=true (alt syntax)", () => {
		process.env.BLOK_ROUTING_LEGACY = "true";
		expect(isFileBasedRoutingEnabled()).toBe(false);
	});

	it("BLOK_ROUTING_LEGACY=1 overrides BLOK_FILE_BASED_ROUTING=true (legacy wins)", () => {
		process.env.BLOK_FILE_BASED_ROUTING = "true";
		process.env.BLOK_ROUTING_LEGACY = "1";
		expect(isFileBasedRoutingEnabled()).toBe(false);
	});

	it("returns true with BLOK_ROUTING_LEGACY set to a non-truthy value (anything other than `1` / `true`)", () => {
		process.env.BLOK_ROUTING_LEGACY = "no";
		expect(isFileBasedRoutingEnabled()).toBe(true);
	});

	it("returns true with BLOK_FILE_BASED_ROUTING set to anything other than the literal string `false`", () => {
		process.env.BLOK_FILE_BASED_ROUTING = "0"; // not literally "false" → still ON
		expect(isFileBasedRoutingEnabled()).toBe(true);
	});
});
