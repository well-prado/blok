import { describe, expect, it } from "vitest";
import { resolveWorkflowNodePosition, withWorkflowNodePositions } from "./workflowLayout";

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

describe("withWorkflowNodePositions", () => {
	it("updates stable step ids while preserving sidecar and node metadata", () => {
		const config = {
			schemaVersion: 1 as const,
			workflow: "old-name",
			canvas: { direction: "LR" as const, future: true },
			nodes: {
				moved: { x: 1, y: 2, collapsed: true, future: "keep" },
				orphan: { x: 3, y: 4 },
			},
			futureRoot: { keep: true },
		};

		expect(
			withWorkflowNodePositions(config, "checkout", [
				{ stepId: "moved", position: { x: 10.4, y: 20.6 } },
				{ position: { x: 999, y: 999 } },
			]),
		).toEqual({
			...config,
			workflow: "checkout",
			nodes: {
				moved: { x: 10, y: 21, collapsed: true, future: "keep" },
				orphan: { x: 3, y: 4 },
			},
		});
	});

	it("creates the minimal v1 sidecar for a first save", () => {
		expect(withWorkflowNodePositions(null, "checkout", [{ stepId: "pay", position: { x: 10, y: 20 } }])).toEqual({
			schemaVersion: 1,
			workflow: "checkout",
			canvas: { direction: "TB" },
			nodes: { pay: { x: 10, y: 20 } },
		});
	});
});
