/**
 * Guards the CLI-delivered pub/sub scaffold workflow (the verifiable NATS
 * consumer). Loads the actual template file and runs it through the REAL engine
 * (the fixed WorkflowTestRunner), asserting the entry handle refs resolve: the
 * `tpl` message reads `msg.params.topic`, and the `attrs` read `msg.params.messageId`
 * + `msg.body`. The log step is ephemeral (no state slot), so we capture the
 * resolved inputs via the node mock.
 */
import { WorkflowTestRunner } from "@blokjs/runner/testing";
import { describe, expect, it } from "vitest";
import onMessage from "../template/src/workflows/messages/on-message";

describe("pubsub template workflow — @blokjs/core typed-handle migration", () => {
	it("runs through the real engine; msg.body + msg.params refs resolve", async () => {
		const wf = await onMessage;
		const runner = new WorkflowTestRunner();
		// The consumer logs via node("@blokjs/log"); capture its resolved inputs.
		let captured: { level?: string; message?: string; attrs?: Record<string, unknown> } | undefined;
		runner.mockNode("@blokjs/log", async (input) => {
			captured = input as typeof captured;
			return input;
		});
		runner.loadWorkflow(wf as unknown as object);

		const result = await runner.execute(
			{ hello: "world" },
			{ params: { topic: "my-topic", subscription: "my-subscription", messageId: "m-1" } },
		);

		expect(result.success).toBe(true);
		expect(captured?.level).toBe("info");
		expect(captured?.message).toBe("pubsub consumed a message on my-topic"); // tpl reads msg.params.topic
		expect(captured?.attrs).toEqual({
			messageId: "m-1", // msg.params.messageId
			body: { hello: "world" }, // msg.body
		});
	});
});
