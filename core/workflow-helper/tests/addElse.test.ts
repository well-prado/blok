import { describe, expect, it } from "vitest";
import AddElse from "../src/components/AddElse";

describe("AddElse", () => {
	describe("addStep()", () => {
		it("should add step to internal steps array", () => {
			const addElse = new AddElse();
			addElse.addStep({ name: "else-step", node: "some-node-pkg", type: "module" });
			const result = addElse.build();
			expect(result.steps).toHaveLength(1);
		});

		it("should support chaining", () => {
			const addElse = new AddElse();
			const returned = addElse.addStep({ name: "else-step", node: "some-node-pkg", type: "module" });
			expect(returned).toBe(addElse);
		});
	});

	describe("build()", () => {
		it("should return ConditionElseOpts with type=else", () => {
			const result = new AddElse().build();
			expect(result.type).toBe("else");
		});

		it("should include all added steps", () => {
			const addElse = new AddElse();
			addElse
				.addStep({ name: "step-a", node: "node-a-package", type: "module" })
				.addStep({ name: "step-b", node: "node-b-package", type: "local" });
			const result = addElse.build();
			expect(result.steps).toHaveLength(2);
			expect(result.steps![0].name).toBe("step-a");
			expect(result.steps![1].name).toBe("step-b");
		});
	});
});
