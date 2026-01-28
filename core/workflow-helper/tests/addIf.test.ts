import { describe, expect, it } from "vitest";
import AddIf from "../src/components/AddIf";

describe("AddIf", () => {
	it("should store condition string", () => {
		const addIf = new AddIf("ctx.request.body.active === true");
		const result = addIf.build();
		expect(result.condition).toBe("ctx.request.body.active === true");
	});

	describe("addStep()", () => {
		it("should add step to internal steps array", () => {
			const addIf = new AddIf("true");
			addIf.addStep({ name: "step-one", node: "some-node-pkg", type: "module" });
			const result = addIf.build();
			expect(result.steps).toHaveLength(1);
			expect(result.steps![0].name).toBe("step-one");
		});

		it("should support chaining", () => {
			const addIf = new AddIf("true");
			const returned = addIf.addStep({ name: "step-one", node: "some-node-pkg", type: "module" });
			expect(returned).toBe(addIf);
		});

		it("should support multiple steps", () => {
			const addIf = new AddIf("true");
			addIf
				.addStep({ name: "step-one", node: "some-node-pkg", type: "module" })
				.addStep({ name: "step-two", node: "other-node-pkg", type: "local" });
			const result = addIf.build();
			expect(result.steps).toHaveLength(2);
		});
	});

	describe("build()", () => {
		it("should return ConditionOpts with type=if", () => {
			const result = new AddIf("x > 0").build();
			expect(result.type).toBe("if");
		});

		it("should include condition string and steps", () => {
			const addIf = new AddIf("ctx.vars.flag");
			addIf.addStep({ name: "my-step", node: "some-node-pkg", type: "module" });
			const result = addIf.build();
			expect(result.condition).toBe("ctx.vars.flag");
			expect(result.steps).toBeDefined();
		});

		it("should throw on empty condition", () => {
			const addIf = new AddIf("");
			expect(() => addIf.build()).toThrow();
		});
	});
});
