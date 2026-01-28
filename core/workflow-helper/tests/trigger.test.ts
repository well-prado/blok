import { describe, expect, it } from "vitest";
import StepNode from "../src/components/StepNode";
import Workflow from "../src/components/Workflow";

describe("Trigger", () => {
	function createWorkflow() {
		return Workflow({ name: "test-workflow", version: "1.0.0" });
	}

	describe("addTrigger()", () => {
		it("should accept http trigger with config", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("http", { method: "GET", path: "/" });
			expect(step).toBeInstanceOf(StepNode);
		});

		it("should accept grpc trigger without config", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("grpc");
			expect(step).toBeInstanceOf(StepNode);
		});

		it("should accept manual trigger", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("manual");
			expect(step).toBeInstanceOf(StepNode);
		});

		it("should accept cron trigger", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("cron");
			expect(step).toBeInstanceOf(StepNode);
		});

		it("should accept queue trigger", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("queue");
			expect(step).toBeInstanceOf(StepNode);
		});

		it("should accept webhook trigger", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("webhook");
			expect(step).toBeInstanceOf(StepNode);
		});

		it("should reject invalid trigger name", () => {
			const trigger = createWorkflow();
			expect(() => trigger.addTrigger("invalid" as any)).toThrow();
		});

		it("should set trigger in config", () => {
			const trigger = createWorkflow();
			const step = trigger.addTrigger("http", { method: "POST", path: "/api" });
			const json = JSON.parse(step.toJson());
			expect(json.trigger).toBeDefined();
			expect(json.trigger.http).toBeDefined();
			expect(json.trigger.http.method).toBe("POST");
		});
	});
});
