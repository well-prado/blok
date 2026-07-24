/**
 * `blokctl dev` port resolution.
 *
 * Regression: the project-config port was passed as `PORT` on every trigger
 * spawn, overwriting the operator's own `PORT` (and beating `.env.local`, since
 * an explicitly-passed env var wins over bun's dotenv loading). `blokctl dev`
 * therefore always tried the config port — 4000 by default — and died with
 * "Failed to start server. Is port 4000 in use?" whenever it was taken, with no
 * flag to work around it.
 */

import { describe, expect, it } from "vitest";
import { resolveDevPortOverride, resolveTriggerPort } from "../src/commands/dev/index.js";

describe("resolveDevPortOverride", () => {
	it("prefers --port over the environment", () => {
		expect(resolveDevPortOverride("4400", "4000")).toEqual({ port: 4400 });
	});

	it("falls back to an explicit PORT in the environment", () => {
		expect(resolveDevPortOverride(undefined, "4400")).toEqual({ port: 4400 });
	});

	it("returns no override when neither is set (caller uses the project config)", () => {
		expect(resolveDevPortOverride(undefined, undefined)).toEqual({});
	});

	it("treats an empty/whitespace PORT as unset rather than NaN", () => {
		expect(resolveDevPortOverride(undefined, "")).toEqual({});
		expect(resolveDevPortOverride(undefined, "   ")).toEqual({});
	});

	it("rejects non-numeric and out-of-range ports instead of binding NaN", () => {
		expect(resolveDevPortOverride("abc", undefined).error).toMatch(/Invalid port/);
		expect(resolveDevPortOverride("0", undefined).error).toMatch(/Invalid port/);
		expect(resolveDevPortOverride("70000", undefined).error).toMatch(/Invalid port/);
		expect(resolveDevPortOverride("4400.5", undefined).error).toMatch(/Invalid port/);
	});
});

describe("resolveTriggerPort", () => {
	it("applies the override to the HTTP trigger", () => {
		expect(resolveTriggerPort({ kind: "http", port: 4000 }, 4400)).toBe(4400);
	});

	it("leaves every other trigger on its configured port (no bind collisions)", () => {
		// Forcing one port onto a multi-trigger project would collide on bind.
		expect(resolveTriggerPort({ kind: "grpc", port: 5000 }, 4400)).toBe(5000);
		expect(resolveTriggerPort({ kind: "worker", port: 4001 }, 4400)).toBe(4001);
		expect(resolveTriggerPort({ kind: "cron", port: 4002 }, 4400)).toBe(4002);
	});

	it("uses the configured port when there is no override", () => {
		expect(resolveTriggerPort({ kind: "http", port: 4000 }, undefined)).toBe(4000);
	});
});
