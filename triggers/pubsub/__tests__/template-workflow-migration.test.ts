/**
 * Guards the CLI-delivered pub/sub scaffold workflow after its migration to the
 * `@blokjs/core` typed-handle DSL. Loads the actual template file and runs it
 * through the REAL engine (the fixed WorkflowTestRunner), asserting the entry
 * handle refs (`msg.body`, `msg.params.*`) resolve and the step lands on
 * `state["log-message"]`.
 */
import { WorkflowTestRunner } from "@blokjs/runner/testing";
import { describe, expect, it } from "vitest";
import onMessage from "../template/src/workflows/messages/on-message";

describe("pubsub template workflow — @blokjs/core typed-handle migration", () => {
	it("runs through the real engine; msg.body + msg.params refs resolve", async () => {
		const wf = await onMessage;
		const runner = new WorkflowTestRunner();
		// The published node is referenced by node("@blokjs/api-call"); mock it.
		runner.mockNode("@blokjs/api-call", async (input) => input);
		runner.loadWorkflow(wf as unknown as object);

		const result = await runner.execute(
			{ hello: "world" },
			{ params: { topic: "my-topic", subscription: "my-subscription", messageId: "m-1" } },
		);

		expect(result.success).toBe(true);
		const slot = result.state?.["log-message"] as { body?: Record<string, unknown> } | undefined;
		expect(slot?.body).toEqual({
			message: { hello: "world" }, // msg.body
			topic: "my-topic", // msg.params.topic
			messageId: "m-1", // msg.params.messageId
		});
	});
});
