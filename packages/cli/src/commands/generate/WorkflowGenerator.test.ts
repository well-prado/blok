/**
 * WorkflowGenerator Tests
 *
 * Tests the workflow generator prompt building and configuration (non-AI parts)
 */

import { describe, expect, it } from "vitest";
import WorkflowGenerator from "./WorkflowGenerator.js";

describe("WorkflowGenerator", () => {
	describe("buildEnhancedPrompt (via reflection)", () => {
		const generator = new WorkflowGenerator();
		const buildPrompt = (userPrompt: string, triggerType: string, workflowName: string) =>
			(generator as unknown as { buildEnhancedPrompt: (u: string, t: string, n: string) => string }).buildEnhancedPrompt(userPrompt, triggerType, workflowName);

		it("should include workflow name and user prompt", () => {
			const result = buildPrompt("Fetch user data from API", "http", "user-api");
			expect(result).toContain("user-api");
			expect(result).toContain("Fetch user data from API");
		});

		it("should include http trigger guidance for http type", () => {
			const result = buildPrompt("Handle REST requests", "http", "rest-api");
			expect(result).toContain("http");
			expect(result).toContain("HTTP trigger");
		});

		it("should include queue trigger guidance for queue type", () => {
			const result = buildPrompt("Process messages", "queue", "message-processor");
			expect(result).toContain("queue");
			expect(result).toContain("queue trigger");
		});

		it("should include pubsub trigger guidance for pubsub type", () => {
			const result = buildPrompt("Process events", "pubsub", "event-handler");
			expect(result).toContain("pubsub");
			expect(result).toContain("pub/sub trigger");
		});

		it("should include cron trigger guidance for cron type", () => {
			const result = buildPrompt("Run hourly job", "cron", "hourly-job");
			expect(result).toContain("cron");
			expect(result).toContain("cron trigger");
		});

		it("should include webhook trigger guidance for webhook type", () => {
			const result = buildPrompt("Handle GitHub events", "webhook", "github-handler");
			expect(result).toContain("webhook");
			expect(result).toContain("webhook trigger");
		});

		it("should include websocket trigger guidance for websocket type", () => {
			const result = buildPrompt("Real-time updates", "websocket", "realtime");
			expect(result).toContain("websocket");
			expect(result).toContain("WebSocket trigger");
		});

		it("should include sse trigger guidance for sse type", () => {
			const result = buildPrompt("Stream updates", "sse", "event-stream");
			expect(result).toContain("sse");
			expect(result).toContain("SSE trigger");
		});

		it("should skip trigger-specific guidance for auto type", () => {
			const result = buildPrompt("Do something", "auto", "auto-workflow");
			expect(result).not.toContain("MUST use the");
		});
	});

	describe("createFeedbackPrompt (via reflection)", () => {
		const generator = new WorkflowGenerator();
		const createFeedback = (originalPrompt: string, previousJson: string, errors: string[]) =>
			(generator as unknown as { createFeedbackPrompt: (o: string, j: string, e: string[]) => string }).createFeedbackPrompt(originalPrompt, previousJson, errors);

		it("should include original prompt in feedback", () => {
			const result = createFeedback("Build a user API", "{}", ["Missing name field"]);
			expect(result).toContain("Build a user API");
		});

		it("should include all validation errors", () => {
			const errors = ["Missing name field", "Invalid trigger type", "Step has no matching node"];
			const result = createFeedback("Test", "{}", errors);

			for (const error of errors) {
				expect(result).toContain(error);
			}
		});

		it("should include previous JSON for reference", () => {
			const previousJson = '{"name": "test", "version": "1.0.0"}';
			const result = createFeedback("Test", previousJson, ["Error"]);
			expect(result).toContain(previousJson);
		});

		it("should include common fix suggestions", () => {
			const result = createFeedback("Test", "{}", ["Missing node entry"]);
			expect(result).toContain("step name has a matching entry");
			expect(result).toContain("else branch");
		});
	});
});
