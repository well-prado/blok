/**
 * WorkflowGenerator End-to-End Tests
 *
 * Tests the full workflow generation pipeline with mocked LLM responses.
 * Validates JSON parsing, structural validation, trigger-type validation,
 * and the 3-attempt feedback loop without requiring an actual OpenAI API key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the ai module
vi.mock("ai", () => ({
	generateText: vi.fn(),
}));

// Mock @ai-sdk/openai
vi.mock("@ai-sdk/openai", () => ({
	createOpenAI: vi.fn(() => (model: string) => ({ model })),
}));

import { generateText } from "ai";
import WorkflowGenerator from "../WorkflowGenerator.js";

const mockedGenerateText = vi.mocked(generateText);

// --- Mock LLM Responses ---

const VALID_HTTP_WORKFLOW = JSON.stringify(
	{
		name: "User API",
		description: "Fetches user data from external API",
		version: "1.0.0",
		trigger: {
			http: {
				method: "GET",
				path: "/api/users/:id",
				accept: "application/json",
			},
		},
		steps: [
			{
				name: "fetch-user",
				node: "@blok/api-call",
				type: "module",
			},
		],
		nodes: {
			"fetch-user": {
				inputs: {
					url: "https://api.example.com/users/${ctx.request.params.id}",
					method: "GET",
					headers: { Authorization: "Bearer ${ctx.env.API_KEY}" },
				},
			},
		},
	},
	null,
	2,
);

const VALID_QUEUE_WORKFLOW = JSON.stringify(
	{
		name: "Event Processor",
		description: "Processes events from Kafka queue",
		version: "1.0.0",
		trigger: {
			queue: {
				provider: "kafka",
				topic: "user-events",
				consumerGroup: "event-processor",
				ack: true,
			},
		},
		steps: [
			{
				name: "process-event",
				node: "event-handler",
				type: "module",
			},
		],
		nodes: {
			"process-event": {
				inputs: {
					eventType: "${ctx.request.body.type}",
					payload: "${ctx.request.body.data}",
				},
			},
		},
	},
	null,
	2,
);

const VALID_CRON_WORKFLOW = JSON.stringify(
	{
		name: "Daily Report",
		description: "Generates daily reports every morning",
		version: "1.0.0",
		trigger: {
			cron: {
				schedule: "0 8 * * *",
				timezone: "America/New_York",
				overlap: false,
			},
		},
		steps: [
			{
				name: "generate-report",
				node: "report-generator",
				type: "module",
			},
		],
		nodes: {
			"generate-report": {
				inputs: {
					format: "html",
					recipients: ["admin@example.com"],
				},
			},
		},
	},
	null,
	2,
);

const VALID_WEBHOOK_WORKFLOW = JSON.stringify(
	{
		name: "GitHub Handler",
		description: "Handles GitHub webhook events",
		version: "1.0.0",
		trigger: {
			webhook: {
				source: "github",
				events: ["push", "pull_request.*"],
				secret: "${process.env.GITHUB_WEBHOOK_SECRET}",
			},
		},
		steps: [
			{
				name: "handle-event",
				node: "github-event-handler",
				type: "module",
			},
		],
		nodes: {
			"handle-event": {
				inputs: {
					event: "${ctx.request.body}",
					eventType: "${ctx.request.headers['x-github-event']}",
				},
			},
		},
	},
	null,
	2,
);

const INVALID_WORKFLOW_MISSING_STEPS = JSON.stringify({
	name: "Broken Workflow",
	version: "1.0.0",
	trigger: { http: { method: "GET" } },
	steps: [],
	nodes: {},
});

const INVALID_WORKFLOW_BAD_TRIGGER = JSON.stringify({
	name: "Bad Trigger Workflow",
	version: "1.0.0",
	trigger: { invalid_trigger: {} },
	steps: [{ name: "step1", node: "node1", type: "module" }],
	nodes: { step1: { inputs: {} } },
});

const INVALID_WORKFLOW_MISMATCHED_NODES = JSON.stringify({
	name: "Mismatched Workflow",
	version: "1.0.0",
	trigger: { http: { method: "GET" } },
	steps: [
		{ name: "step1", node: "node1", type: "module" },
		{ name: "step2", node: "node2", type: "module" },
	],
	nodes: {
		step1: { inputs: {} },
		// step2 is missing!
	},
});

describe("WorkflowGenerator E2E", () => {
	let generator: WorkflowGenerator;

	beforeEach(() => {
		generator = new WorkflowGenerator();
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("successful generation - HTTP trigger", () => {
		it("should generate a valid HTTP workflow on first attempt", async () => {
			mockedGenerateText.mockResolvedValueOnce({
				text: VALID_HTTP_WORKFLOW,
			} as never);

			const result = await generator.generateWorkflow(
				"user-api",
				"Create an API that fetches user data",
				"test-api-key",
				"http",
			);

			expect(result.workflowName).toBe("user-api");
			expect(result.triggerType).toBe("http");
			expect(result.validationResult).toBeDefined();
			expect(result.validationResult!.valid).toBe(true);
			expect(result.validationResult!.attempts).toBe(1);
			expect(mockedGenerateText).toHaveBeenCalledTimes(1);

			// Verify JSON is parseable
			const parsed = JSON.parse(result.json);
			expect(parsed.name).toBe("User API");
			expect(parsed.trigger.http).toBeDefined();
		});
	});

	describe("successful generation - Queue trigger", () => {
		it("should generate a valid queue workflow on first attempt", async () => {
			mockedGenerateText.mockResolvedValueOnce({
				text: VALID_QUEUE_WORKFLOW,
			} as never);

			const result = await generator.generateWorkflow(
				"event-processor",
				"Process events from Kafka",
				"test-api-key",
				"queue",
			);

			expect(result.validationResult!.valid).toBe(true);
			expect(result.validationResult!.attempts).toBe(1);

			const parsed = JSON.parse(result.json);
			expect(parsed.trigger.queue.provider).toBe("kafka");
			expect(parsed.trigger.queue.topic).toBe("user-events");
		});
	});

	describe("successful generation - Cron trigger", () => {
		it("should generate a valid cron workflow on first attempt", async () => {
			mockedGenerateText.mockResolvedValueOnce({
				text: VALID_CRON_WORKFLOW,
			} as never);

			const result = await generator.generateWorkflow(
				"daily-report",
				"Generate daily reports at 8am",
				"test-api-key",
				"cron",
			);

			expect(result.validationResult!.valid).toBe(true);

			const parsed = JSON.parse(result.json);
			expect(parsed.trigger.cron.schedule).toBe("0 8 * * *");
			expect(parsed.trigger.cron.timezone).toBe("America/New_York");
		});
	});

	describe("successful generation - Webhook trigger", () => {
		it("should generate a valid webhook workflow on first attempt", async () => {
			mockedGenerateText.mockResolvedValueOnce({
				text: VALID_WEBHOOK_WORKFLOW,
			} as never);

			const result = await generator.generateWorkflow(
				"github-handler",
				"Handle GitHub webhook events for push and PR",
				"test-api-key",
				"webhook",
			);

			expect(result.validationResult!.valid).toBe(true);

			const parsed = JSON.parse(result.json);
			expect(parsed.trigger.webhook.source).toBe("github");
			expect(parsed.trigger.webhook.events).toContain("push");
		});
	});

	describe("markdown fence cleanup", () => {
		it("should strip markdown JSON fences from LLM response", async () => {
			const wrappedJson = "```json\n" + VALID_HTTP_WORKFLOW + "\n```";

			mockedGenerateText.mockResolvedValueOnce({
				text: wrappedJson,
			} as never);

			const result = await generator.generateWorkflow(
				"test-workflow",
				"Create a test workflow",
				"test-api-key",
				"http",
			);

			expect(result.validationResult!.valid).toBe(true);
			// The JSON should be clean (no markdown fences)
			expect(result.json).not.toContain("```");
		});
	});

	describe("validation feedback loop", () => {
		it("should retry with feedback on first failure and succeed on second attempt", async () => {
			// First attempt: invalid (empty steps)
			mockedGenerateText.mockResolvedValueOnce({
				text: INVALID_WORKFLOW_MISSING_STEPS,
			} as never);

			// Second attempt: valid
			mockedGenerateText.mockResolvedValueOnce({
				text: VALID_HTTP_WORKFLOW,
			} as never);

			const result = await generator.generateWorkflow("user-api", "Create a user API", "test-api-key", "http");

			expect(result.validationResult!.valid).toBe(true);
			expect(result.validationResult!.attempts).toBe(2);
			expect(mockedGenerateText).toHaveBeenCalledTimes(2);
		});

		it("should include validation errors in feedback prompt", async () => {
			// First attempt: bad trigger
			mockedGenerateText.mockResolvedValueOnce({
				text: INVALID_WORKFLOW_BAD_TRIGGER,
			} as never);

			// Second attempt: valid
			mockedGenerateText.mockResolvedValueOnce({
				text: VALID_HTTP_WORKFLOW,
			} as never);

			await generator.generateWorkflow("test-workflow", "Create a test workflow", "test-api-key", "http");

			// Second call should contain feedback
			const secondCallArgs = mockedGenerateText.mock.calls[1][0] as Record<string, unknown>;
			const prompt = secondCallArgs.prompt as string;
			expect(prompt).toContain("validation errors");
			expect(prompt).toContain("invalid_trigger");
		});

		it("should exhaust all 3 attempts when workflow keeps failing", async () => {
			mockedGenerateText.mockResolvedValue({
				text: INVALID_WORKFLOW_MISSING_STEPS,
			} as never);

			const result = await generator.generateWorkflow(
				"broken-workflow",
				"Create something broken",
				"test-api-key",
				"http",
			);

			expect(result.validationResult!.valid).toBe(false);
			expect(result.validationResult!.attempts).toBe(3);
			expect(mockedGenerateText).toHaveBeenCalledTimes(3);
		});

		it("should fix mismatched nodes on retry", async () => {
			// First attempt: step2 has no matching node
			mockedGenerateText.mockResolvedValueOnce({
				text: INVALID_WORKFLOW_MISMATCHED_NODES,
			} as never);

			// Second attempt: fixed
			mockedGenerateText.mockResolvedValueOnce({
				text: VALID_HTTP_WORKFLOW,
			} as never);

			const result = await generator.generateWorkflow("user-api", "Create a user API", "test-api-key", "http");

			expect(result.validationResult!.valid).toBe(true);
			expect(result.validationResult!.attempts).toBe(2);
		});
	});

	describe("invalid JSON handling", () => {
		it("should handle LLM returning invalid JSON", async () => {
			mockedGenerateText.mockResolvedValue({
				text: "This is not valid JSON at all {{{",
			} as never);

			const result = await generator.generateWorkflow("broken-workflow", "Create something", "test-api-key", "http");

			expect(result.validationResult!.valid).toBe(false);
			expect(result.validationResult!.errors.some((e: string) => e.includes("Invalid JSON"))).toBe(true);
			expect(result.validationResult!.attempts).toBe(3);
		});
	});

	describe("trigger type enforcement", () => {
		it("should include trigger type context in prompt for queue", async () => {
			mockedGenerateText.mockResolvedValueOnce({
				text: VALID_QUEUE_WORKFLOW,
			} as never);

			await generator.generateWorkflow("event-processor", "Process events", "test-api-key", "queue");

			const callArgs = mockedGenerateText.mock.calls[0][0] as Record<string, unknown>;
			const prompt = callArgs.prompt as string;
			expect(prompt).toContain("queue");
			expect(prompt).toContain('MUST use the "queue" trigger type');
		});

		it("should not enforce trigger type for auto mode", async () => {
			mockedGenerateText.mockResolvedValueOnce({
				text: VALID_HTTP_WORKFLOW,
			} as never);

			await generator.generateWorkflow("auto-workflow", "Create an API", "test-api-key", "auto");

			const callArgs = mockedGenerateText.mock.calls[0][0] as Record<string, unknown>;
			const prompt = callArgs.prompt as string;
			expect(prompt).not.toContain("MUST use the");
		});
	});

	describe("conditional workflow generation", () => {
		it("should validate conditional workflows with if-else routing", async () => {
			const conditionalWorkflow = JSON.stringify(
				{
					name: "CRUD Router",
					description: "Routes CRUD operations",
					version: "1.0.0",
					trigger: {
						http: {
							method: "*",
							path: "/:function?/:id?",
							accept: "application/json",
						},
					},
					steps: [
						{
							name: "route-request",
							node: "@blok/if-else",
							type: "module",
						},
					],
					nodes: {
						"route-request": {
							conditions: [
								{
									type: "if",
									condition: 'ctx.request.method.toLowerCase() === "get"',
									steps: [{ name: "get-data", node: "data-fetcher", type: "module" }],
								},
								{
									type: "if",
									condition: 'ctx.request.method.toLowerCase() === "post"',
									steps: [{ name: "create-data", node: "data-creator", type: "module" }],
								},
								{
									type: "else",
									steps: [{ name: "error-handler", node: "error", type: "module" }],
								},
							],
						},
						"get-data": { inputs: {} },
						"create-data": { inputs: { body: "${ctx.request.body}" } },
						"error-handler": { inputs: { message: "Method not allowed", code: 405 } },
					},
				},
				null,
				2,
			);

			mockedGenerateText.mockResolvedValueOnce({
				text: conditionalWorkflow,
			} as never);

			const result = await generator.generateWorkflow(
				"crud-router",
				"Create a CRUD router with conditional routing",
				"test-api-key",
				"http",
			);

			expect(result.validationResult!.valid).toBe(true);
			expect(result.validationResult!.attempts).toBe(1);
		});
	});
});
