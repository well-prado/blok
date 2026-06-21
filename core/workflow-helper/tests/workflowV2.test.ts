import { describe, expect, it } from "vitest";
import { workflow } from "../src/index";

/**
 * Bug 01 (part A) + F16 — the v2 `workflow()` factory must:
 *  - accept `middleware: true` and let a middleware-only workflow omit a
 *    trigger (Problem B), carrying the flag onto `_config` + `toJson()`;
 *  - enforce the v2 envelope's scalar constraints (`name.min(3)`,
 *    `version.min(5)`) so the recommended TS path stops being the
 *    *less*-validated authoring surface.
 */

const minimalStep = { id: "x", use: "@blokjs/respond", inputs: {} } as const;

describe("workflow() — middleware authoring (Bug 01 part A)", () => {
	it("constructs a trigger-less `middleware: true` workflow without throwing", () => {
		expect(() =>
			workflow({
				name: "request-id",
				version: "1.0.0",
				middleware: true,
				steps: [minimalStep],
			}),
		).not.toThrow();
	});

	it("carries `middleware: true` on `_config`", () => {
		const wf = workflow({
			name: "request-id",
			version: "1.0.0",
			middleware: true,
			steps: [minimalStep],
		});
		expect((wf._config as { middleware?: unknown }).middleware).toBe(true);
	});

	it('emits `"middleware":true` from toJson()', () => {
		const wf = workflow({
			name: "request-id",
			version: "1.0.0",
			middleware: true,
			steps: [minimalStep],
		});
		const json = JSON.parse(wf.toJson());
		expect(json.middleware).toBe(true);
	});

	it("still carries `middleware: true` when a dummy trigger is present (workaround back-compat)", () => {
		const wf = workflow({
			name: "request-id",
			version: "1.0.0",
			middleware: true,
			trigger: { http: { method: "ANY", path: "/__mw/request-id" } },
			steps: [minimalStep],
		});
		expect((wf._config as { middleware?: unknown }).middleware).toBe(true);
		expect(JSON.parse(wf.toJson()).middleware).toBe(true);
	});

	it("a non-middleware workflow with no trigger still throws `requires a trigger`", () => {
		expect(() =>
			workflow({
				name: "no-trigger",
				version: "1.0.0",
				steps: [minimalStep],
			} as unknown as Parameters<typeof workflow>[0]),
		).toThrow(/requires a trigger/);
	});

	it("does NOT carry a `middleware` key when the flag is omitted", () => {
		const wf = workflow({
			name: "plain",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/plain" } },
			steps: [minimalStep],
		});
		expect("middleware" in (wf._config as Record<string, unknown>)).toBe(false);
		expect("middleware" in JSON.parse(wf.toJson())).toBe(false);
	});
});

describe("workflow() — envelope validation (F16)", () => {
	it("rejects a name shorter than 3 characters", () => {
		expect(() =>
			workflow({
				name: "ab",
				version: "1.0.0",
				trigger: { http: { method: "GET", path: "/x" } },
				steps: [minimalStep],
			}),
		).toThrow(/failed validation/);
	});

	it("rejects a version shorter than 5 characters (not x.x.x)", () => {
		expect(() =>
			workflow({
				name: "ValidName",
				version: "1.0",
				trigger: { http: { method: "GET", path: "/x" } },
				steps: [minimalStep],
			}),
		).toThrow(/failed validation/);
	});

	it("accepts a valid name + version", () => {
		expect(() =>
			workflow({
				name: "ValidName",
				version: "1.0.0",
				trigger: { http: { method: "GET", path: "/x" } },
				steps: [minimalStep],
			}),
		).not.toThrow();
	});

	it("envelope validation also applies to a trigger-less middleware workflow", () => {
		expect(() =>
			workflow({
				name: "ab",
				version: "1.0.0",
				middleware: true,
				steps: [minimalStep],
			}),
		).toThrow(/failed validation/);
	});
});

describe("workflow() — empty steps", () => {
	it("throws when `steps` is empty", () => {
		expect(() =>
			workflow({
				name: "no-steps",
				version: "1.0.0",
				trigger: { http: { method: "GET", path: "/x" } },
				steps: [],
			}),
		).toThrow(/requires at least one step/);
	});

	it("throws on empty steps even for a trigger-less middleware workflow", () => {
		expect(() =>
			workflow({
				name: "no-steps",
				version: "1.0.0",
				middleware: true,
				steps: [],
			}),
		).toThrow(/requires at least one step/);
	});
});
