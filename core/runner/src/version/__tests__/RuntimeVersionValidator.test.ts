import { describe, expect, it } from "vitest";
import { RuntimeVersionValidator } from "../RuntimeVersionValidator";

describe("RuntimeVersionValidator", () => {
	describe("validateNode", () => {
		it("returns empty for node without requirements", () => {
			const validator = new RuntimeVersionValidator({ python3: "3.12.0" });
			const results = validator.validateNode({ name: "simple-node" });
			expect(results).toEqual([]);
		});

		it("passes when version satisfies >= constraint", () => {
			const validator = new RuntimeVersionValidator({ python3: "3.12.0" });
			const results = validator.validateNode({
				name: "ml-node",
				runtimeRequirements: { python3: ">=3.10.0" },
			});
			expect(results).toHaveLength(1);
			expect(results[0].valid).toBe(true);
		});

		it("fails when version does not satisfy >= constraint", () => {
			const validator = new RuntimeVersionValidator({ python3: "3.9.7" });
			const results = validator.validateNode({
				name: "ml-node",
				runtimeRequirements: { python3: ">=3.11.0" },
			});
			expect(results).toHaveLength(1);
			expect(results[0].valid).toBe(false);
			expect(results[0].message).toContain("requires python3 >=3.11.0");
			expect(results[0].message).toContain("found 3.9.7");
		});

		it("fails when runtime version is not known", () => {
			const validator = new RuntimeVersionValidator({});
			const results = validator.validateNode({
				name: "go-node",
				runtimeRequirements: { go: ">=1.21.0" },
			});
			expect(results).toHaveLength(1);
			expect(results[0].valid).toBe(false);
			expect(results[0].actual).toBeUndefined();
			expect(results[0].message).toContain("no go runtime version is known");
		});

		it("validates multiple runtime requirements", () => {
			const validator = new RuntimeVersionValidator({
				python3: "3.12.0",
				go: "1.20.0",
			});
			const results = validator.validateNode({
				name: "multi-node",
				runtimeRequirements: { python3: ">=3.10.0", go: ">=1.21.0" },
			});
			expect(results).toHaveLength(2);
			expect(results[0].valid).toBe(true); // python3 passes
			expect(results[1].valid).toBe(false); // go fails
		});

		it("supports caret constraint", () => {
			const validator = new RuntimeVersionValidator({ go: "1.22.5" });
			const results = validator.validateNode({
				name: "go-node",
				runtimeRequirements: { go: "^1.21.0" },
			});
			expect(results[0].valid).toBe(true);
		});

		it("supports tilde constraint", () => {
			const validator = new RuntimeVersionValidator({ python3: "3.12.4" });
			const results = validator.validateNode({
				name: "py-node",
				runtimeRequirements: { python3: "~3.12.0" },
			});
			expect(results[0].valid).toBe(true);
		});

		it("supports exact constraint", () => {
			const validator = new RuntimeVersionValidator({ rust: "1.78.0" });
			expect(
				validator.validateNode({
					name: "rust-node",
					runtimeRequirements: { rust: "1.78.0" },
				})[0].valid,
			).toBe(true);
			expect(
				validator.validateNode({
					name: "rust-node",
					runtimeRequirements: { rust: "1.78.1" },
				})[0].valid,
			).toBe(false);
		});
	});

	describe("validateWorkflow", () => {
		it("validates all nodes in a workflow", () => {
			const validator = new RuntimeVersionValidator({
				python3: "3.12.0",
				go: "1.22.5",
			});
			const results = validator.validateWorkflow([
				{ name: "node-a", runtimeRequirements: { python3: ">=3.11.0" } },
				{ name: "node-b", runtimeRequirements: { go: ">=1.21.0" } },
				{ name: "node-c" }, // no requirements
			]);
			expect(results).toHaveLength(2);
			expect(results.every((r) => r.valid)).toBe(true);
		});

		it("collects failures across nodes", () => {
			const validator = new RuntimeVersionValidator({
				python3: "3.9.0",
				go: "1.19.0",
			});
			const results = validator.validateWorkflow([
				{ name: "node-a", runtimeRequirements: { python3: ">=3.11.0" } },
				{ name: "node-b", runtimeRequirements: { go: ">=1.21.0" } },
			]);
			expect(results).toHaveLength(2);
			expect(results.every((r) => !r.valid)).toBe(true);
		});
	});

	describe("setRuntimeVersion / getRuntimeVersion", () => {
		it("sets and gets runtime versions", () => {
			const validator = new RuntimeVersionValidator();
			validator.setRuntimeVersion("python3", "3.12.0");
			expect(validator.getRuntimeVersion("python3")).toBe("3.12.0");
			expect(validator.getRuntimeVersion("go")).toBeUndefined();
		});
	});

	describe("formatErrors", () => {
		it("returns empty string when no failures", () => {
			const result = RuntimeVersionValidator.formatErrors([
				{
					valid: true,
					node: "test",
					runtime: "python3",
					required: ">=3.10.0",
					actual: "3.12.0",
					message: "ok",
				},
			]);
			expect(result).toBe("");
		});

		it("formats failure messages", () => {
			const result = RuntimeVersionValidator.formatErrors([
				{
					valid: false,
					node: "ml-node",
					runtime: "python3",
					required: ">=3.11.0",
					actual: "3.9.7",
					message: "requires python3 >=3.11.0",
				},
			]);
			expect(result).toContain("Runtime version requirements not met");
			expect(result).toContain("ml-node");
			expect(result).toContain("python3");
			expect(result).toContain(">=3.11.0");
			expect(result).toContain("3.9.7");
		});
	});
});
