import { describe, expect, it } from "vitest";
import { isSwitchStep, switchOn } from "../src/index";

describe("switchOn()", () => {
	it("returns a v0.5 switch step shape", () => {
		const step = switchOn({
			id: "route-by-tenant",
			on: "$.req.headers['x-tenant-id']",
			cases: [
				{ when: "acme", do: [{ id: "x", subworkflow: "acme-process" }] },
				{ when: "globex", do: [{ id: "y", subworkflow: "globex-process" }] },
			],
		});
		expect(step).toMatchObject({
			id: "route-by-tenant",
			switch: {
				on: "$.req.headers['x-tenant-id']",
				cases: [
					{ when: "acme", do: [{ id: "x", subworkflow: "acme-process" }] },
					{ when: "globex", do: [{ id: "y", subworkflow: "globex-process" }] },
				],
			},
		});
		expect(isSwitchStep(step)).toBe(true);
	});

	it("preserves array `when` values for any-of matching", () => {
		const step = switchOn({
			id: "route",
			on: "$.req.headers['x-event']",
			cases: [
				{
					when: ["pull_request", "pull_request_review"],
					do: [{ id: "h", subworkflow: "pr-handler" }],
				},
			],
		});
		expect(step.switch.cases[0].when).toEqual(["pull_request", "pull_request_review"]);
	});

	it("includes `default` block when provided", () => {
		const step = switchOn({
			id: "x",
			on: "$.req.body.kind",
			cases: [{ when: "a", do: [{ id: "y", use: "@blokjs/api-call" }] }],
			default: [{ id: "fallback", use: "@blokjs/respond", inputs: { status: 400 } }],
		});
		expect(step.switch.default).toEqual([{ id: "fallback", use: "@blokjs/respond", inputs: { status: 400 } }]);
	});

	it("omits `default` from the output when unset", () => {
		const step = switchOn({
			id: "x",
			on: "$.req.body.kind",
			cases: [{ when: "a", do: [{ id: "y" }] }],
		});
		expect(step.switch.default).toBeUndefined();
	});

	it("hoists active:false and stop:true to top level", () => {
		const step = switchOn({
			id: "x",
			on: "$.req.body.kind",
			cases: [{ when: "a", do: [{ id: "y" }] }],
			active: false,
			stop: true,
		});
		expect(step.active).toBe(false);
		expect(step.stop).toBe(true);
	});

	it("rejects missing id", () => {
		// @ts-expect-error — missing required id
		expect(() => switchOn({ on: "x", cases: [{ when: "a", do: [{ id: "y" }] }] })).toThrow(/non-empty `id`/);
	});

	it("rejects missing on", () => {
		// @ts-expect-error — missing required on
		expect(() => switchOn({ id: "x", cases: [{ when: "a", do: [{ id: "y" }] }] })).toThrow(/`on`/);
	});

	it("rejects empty cases array", () => {
		expect(() => switchOn({ id: "x", on: "v", cases: [] })).toThrow(/non-empty array/);
	});

	it("rejects a case missing `when`", () => {
		// @ts-expect-error — missing when
		expect(() => switchOn({ id: "x", on: "v", cases: [{ do: [{ id: "y" }] }] })).toThrow(/missing `when`/);
	});

	it("rejects a case with empty `do`", () => {
		expect(() => switchOn({ id: "x", on: "v", cases: [{ when: "a", do: [] }] })).toThrow(/non-empty array of steps/);
	});

	it("rejects non-array default", () => {
		expect(() =>
			switchOn({
				id: "x",
				on: "v",
				cases: [{ when: "a", do: [{ id: "y" }] }],
				// @ts-expect-error — default must be array
				default: "oops",
			}),
		).toThrow(/non-empty array/);
	});
});
