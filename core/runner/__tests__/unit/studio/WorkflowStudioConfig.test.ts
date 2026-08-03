import { describe, expect, it } from "vitest";
import {
	WORKFLOW_STUDIO_SCHEMA_URL,
	cleanWorkflowStudioOrphans,
	parseWorkflowStudioConfig,
	workflowStudioPath,
} from "../../../src/studio/WorkflowStudioConfig";

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		workflow: "login-flow",
		nodes: { launch: { x: 100, y: 200 } },
		...overrides,
	};
}

describe("workflowStudioPath", () => {
	it.each([
		["/project/src/workflows/login.ts", "/project/src/workflows/login.studio.json"],
		["/project/workflows/json/login.json", "/project/workflows/json/login.studio.json"],
		["/project/src/workflows/login/workflow.ts", "/project/src/workflows/login/workflow.studio.json"],
	])("resolves %s", (source, expected) => {
		expect(workflowStudioPath(source)).toBe(expected);
	});

	it("rejects display provenance and unsupported extensions", () => {
		expect(() => workflowStudioPath('Workflows.ts["login"]')).toThrow(/absolute filesystem path/);
		expect(() => workflowStudioPath("/project/workflows/login.yaml")).toThrow(/unsupported/i);
	});
});

describe("WorkflowStudioConfigV1", () => {
	it("adds stable defaults", () => {
		const parsed = parseWorkflowStudioConfig(config());
		expect(parsed.$schema).toBe(WORKFLOW_STUDIO_SCHEMA_URL);
		expect(parsed.canvas).toEqual({ direction: "TB" });
		expect(parsed.groups).toEqual({});
		expect(parsed.annotations).toEqual([]);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, 1_000_001])("rejects malformed coordinate %s", (x) => {
		expect(() => parseWorkflowStudioConfig(config({ nodes: { launch: { x, y: 0 } } }))).toThrow();
	});

	it("round-trips unknown future keys", () => {
		const parsed = parseWorkflowStudioConfig(
			config({
				futureTopLevel: { enabled: true },
				canvas: { direction: "LR", futureCanvasKey: "kept" },
				nodes: { launch: { x: 1, y: 2, futureNodeKey: ["kept"] } },
			}),
		);

		expect(parsed.futureTopLevel).toEqual({ enabled: true });
		expect(parsed.canvas.futureCanvasKey).toBe("kept");
		expect(parsed.nodes.launch.futureNodeKey).toEqual(["kept"]);
	});

	it("rejects a workflow-name mismatch", () => {
		expect(() => parseWorkflowStudioConfig(config(), "checkout-flow")).toThrow(/login-flow.*checkout-flow/);
	});

	it("retains orphan node keys until cleanup is explicitly requested", () => {
		const parsed = parseWorkflowStudioConfig(
			config({ nodes: { launch: { x: 1, y: 2 }, deletedStep: { x: 3, y: 4 } } }),
		);
		expect(parsed.nodes.deletedStep).toBeDefined();

		const cleaned = cleanWorkflowStudioOrphans(parsed, new Set(["launch"]));
		expect(cleaned.nodes).toEqual({ launch: { x: 1, y: 2 } });
		expect(parsed.nodes.deletedStep).toBeDefined();
	});
});
