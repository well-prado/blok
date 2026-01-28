import { describe, expect, it } from "vitest";
import HelperResponse from "../src/components/HelperResponse";
import type { WorkflowOpts } from "../src/types/WorkflowOpts";

describe("HelperResponse", () => {
	describe("setConfig()", () => {
		it("should store config", () => {
			const response = new HelperResponse();
			const config: WorkflowOpts = { name: "test", version: "1.0.0" };
			response.setConfig(config);
			const json = JSON.parse(response.toJson());
			expect(json.name).toBe("test");
		});
	});

	describe("toJson()", () => {
		it("should return JSON string of config", () => {
			const response = new HelperResponse();
			const config: WorkflowOpts = { name: "my-workflow", version: "2.0.0" };
			response.setConfig(config);
			const result = response.toJson();
			expect(typeof result).toBe("string");
			expect(JSON.parse(result)).toEqual(config);
		});

		it("should return valid JSON", () => {
			const response = new HelperResponse();
			response.setConfig({ name: "test", version: "1.0.0" });
			expect(() => JSON.parse(response.toJson())).not.toThrow();
		});

		it("should handle config with all fields", () => {
			const response = new HelperResponse();
			const config: WorkflowOpts = {
				name: "full-workflow",
				version: "1.0.0",
				description: "A test workflow",
				steps: [],
				nodes: {},
			};
			response.setConfig(config);
			const parsed = JSON.parse(response.toJson());
			expect(parsed.name).toBe("full-workflow");
			expect(parsed.description).toBe("A test workflow");
			expect(parsed.steps).toEqual([]);
			expect(parsed.nodes).toEqual({});
		});
	});
});
