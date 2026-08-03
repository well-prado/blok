import { describe, expect, it } from "vitest";
import { resolveWorkflowNodePosition } from "./workflowLayout";

describe("resolveWorkflowNodePosition", () => {
	const auto = { x: 500, y: 600 };

	it("prefers the sidecar over inline UI and auto-layout", () => {
		expect(resolveWorkflowNodePosition({ x: 10, y: 20 }, { x: 30, y: 40 }, auto)).toEqual({ x: 10, y: 20 });
	});

	it("falls back through inline UI to auto-layout", () => {
		expect(resolveWorkflowNodePosition(undefined, { x: 30, y: 40 }, auto)).toEqual({ x: 30, y: 40 });
		expect(resolveWorkflowNodePosition(undefined, undefined, auto)).toBe(auto);
	});

	it("ignores malformed persisted positions", () => {
		expect(resolveWorkflowNodePosition({ x: Number.NaN, y: 20 }, { x: 30, y: 40 }, auto)).toEqual({ x: 30, y: 40 });
		expect(resolveWorkflowNodePosition({ x: "bad", y: 20 }, null, auto)).toBe(auto);
	});
});
