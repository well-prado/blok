/**
 * Guards the CLI-delivered worker scaffold workflow after its migration to the
 * `@blokjs/core` typed-handle DSL. Loads the actual template file and runs it
 * through the REAL engine, asserting the entry handle refs (`job.body`,
 * `job.params.*`) resolve and the step lands on `state["process-job"]`.
 */
import { WorkflowTestRunner } from "@blokjs/runner/testing";
import { describe, expect, it } from "vitest";
import processJob from "../template/src/workflows/jobs/process-job";

describe("worker template workflow — @blokjs/core typed-handle migration", () => {
	it("runs through the real engine; job.body + job.params refs resolve", async () => {
		const wf = await processJob;
		const runner = new WorkflowTestRunner();
		runner.mockNode("@blokjs/api-call", async (input) => input);
		runner.loadWorkflow(wf as unknown as object);

		const result = await runner.execute(
			{ order: 42 },
			{ params: { queue: "background-jobs", jobId: "j-1", attempt: "0" } },
		);

		expect(result.success).toBe(true);
		const slot = result.state?.["process-job"] as { body?: Record<string, unknown> } | undefined;
		expect(slot?.body).toEqual({
			job: { order: 42 }, // job.body
			queue: "background-jobs", // job.params.queue
			jobId: "j-1", // job.params.jobId
			attempt: "0", // job.params.attempt
		});
	});
});
