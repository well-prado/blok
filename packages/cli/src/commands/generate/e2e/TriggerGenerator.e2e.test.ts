/**
 * TriggerGenerator End-to-End Tests
 *
 * Tests the full trigger generation pipeline with mocked LLM responses and validators.
 * Validates TypeScript compilation, structural validation, trigger-type guidance,
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

// Mock CompilationValidator to avoid real TypeScript compilation in tests
vi.mock("../validators/CompilationValidator.js", () => ({
	validateCode: vi.fn(),
}));

import { generateText } from "ai";
import TriggerGenerator from "../TriggerGenerator.js";
import * as CompilationValidator from "../validators/CompilationValidator.js";

const mockedGenerateText = vi.mocked(generateText);
const mockedValidateCode = vi.mocked(CompilationValidator.validateCode);

// --- Mock LLM Responses ---

const VALID_QUEUE_TRIGGER = `
import { TriggerBase, type GlobalOptions, NodeMap, Runner } from "@blokjs/runner";
import { type Context, DefaultLogger } from "@blokjs/shared";

export default class KafkaQueueTrigger extends TriggerBase {
	private nodeMap: GlobalOptions = <GlobalOptions>{};

	constructor() {
		super();
		this.loadNodes();
		this.loadWorkflows();
	}

	private loadNodes(): void {
		this.nodeMap.nodes = new NodeMap();
	}

	private loadWorkflows(): void {
		this.nodeMap.workflows = [];
	}

	async startConsumer(): Promise<void> {
		const ctx = this.createContext();
		ctx.request = { body: {}, headers: {} };
	}
}
`;

const VALID_CRON_TRIGGER = `
import { TriggerBase, type GlobalOptions, NodeMap } from "@blokjs/runner";

export default class DailyCronTrigger extends TriggerBase {
	private nodeMap: GlobalOptions = <GlobalOptions>{};

	constructor() {
		super();
		this.loadNodes();
		this.loadWorkflows();
	}

	private loadNodes(): void {}
	private loadWorkflows(): void {}

	async startScheduler(): Promise<void> {
		const ctx = this.createContext();
		ctx.request = { body: { scheduledTime: new Date().toISOString() } };
	}
}
`;

const VALID_WEBHOOK_TRIGGER = `
import { TriggerBase, type GlobalOptions, NodeMap } from "@blokjs/runner";

export default class GitHubWebhookTrigger extends TriggerBase {
	private nodeMap: GlobalOptions = <GlobalOptions>{};

	constructor() {
		super();
		this.loadNodes();
		this.loadWorkflows();
	}

	private loadNodes(): void {}
	private loadWorkflows(): void {}

	async listen(): Promise<void> {
		const ctx = this.createContext();
		ctx.request = { body: {}, headers: { "x-github-event": "push" }, method: "POST" };
	}
}
`;

const INVALID_TRIGGER_NO_BASE = `
export default class BrokenTrigger {
	constructor() {
		this.loadNodes();
		this.loadWorkflows();
	}

	private loadNodes() {}
	private loadWorkflows() {}

	async start() {
		const ctx = this.createContext();
	}
}
`;

const INVALID_TRIGGER_NO_METHODS = `
import { TriggerBase } from "@blokjs/runner";

export default class MinimalTrigger extends TriggerBase {
	constructor() {
		super();
	}

	async start() {
		const ctx = this.createContext();
		ctx.request = { body: {} };
	}
}
`;

const INVALID_TRIGGER_NO_CONTEXT = `
import { TriggerBase } from "@blokjs/runner";

export default class NoContextTrigger extends TriggerBase {
	constructor() {
		super();
		this.loadNodes();
		this.loadWorkflows();
	}

	private loadNodes() {}
	private loadWorkflows() {}

	async start() {
		console.log("Started without context");
	}
}
`;

describe("TriggerGenerator E2E", () => {
	let generator: TriggerGenerator;

	beforeEach(() => {
		generator = new TriggerGenerator();
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("successful generation - queue trigger", () => {
		it("should generate a valid queue trigger on first attempt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_QUEUE_TRIGGER } as never);
			mockedValidateCode.mockReturnValue({ success: true, errors: [], warnings: [] });

			const result = await generator.generateTrigger(
				"kafka-queue",
				"queue",
				"Create a Kafka queue trigger that consumes user events",
				"test-api-key",
			);

			expect(result.triggerName).toBe("kafka-queue");
			expect(result.triggerType).toBe("queue");
			expect(result.validationResult).toBeDefined();
			expect(result.validationResult!.valid).toBe(true);
			expect(result.validationResult!.attempts).toBe(1);
			expect(mockedGenerateText).toHaveBeenCalledTimes(1);
		});
	});

	describe("successful generation - cron trigger", () => {
		it("should generate a valid cron trigger on first attempt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_CRON_TRIGGER } as never);
			mockedValidateCode.mockReturnValue({ success: true, errors: [], warnings: [] });

			const result = await generator.generateTrigger(
				"daily-cron",
				"cron",
				"Create a daily cron trigger",
				"test-api-key",
			);

			expect(result.validationResult!.valid).toBe(true);
			expect(result.validationResult!.attempts).toBe(1);
			expect(result.code).toContain("DailyCronTrigger");
		});
	});

	describe("successful generation - webhook trigger", () => {
		it("should generate a valid webhook trigger on first attempt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_WEBHOOK_TRIGGER } as never);
			mockedValidateCode.mockReturnValue({ success: true, errors: [], warnings: [] });

			const result = await generator.generateTrigger(
				"github-webhook",
				"webhook",
				"Create a GitHub webhook trigger",
				"test-api-key",
			);

			expect(result.validationResult!.valid).toBe(true);
			expect(result.code).toContain("GitHubWebhookTrigger");
		});
	});

	describe("trigger-specific prompt guidance", () => {
		it("should include queue-specific guidance in prompt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_QUEUE_TRIGGER } as never);
			mockedValidateCode.mockReturnValue({ success: true, errors: [], warnings: [] });

			await generator.generateTrigger("kafka-trigger", "queue", "Process messages", "test-api-key");

			const callArgs = mockedGenerateText.mock.calls[0][0] as Record<string, unknown>;
			const prompt = callArgs.prompt as string;
			expect(prompt).toContain("message queue broker");
			expect(prompt).toContain("ack/nack");
		});

		it("should include cron-specific guidance in prompt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_CRON_TRIGGER } as never);
			mockedValidateCode.mockReturnValue({ success: true, errors: [], warnings: [] });

			await generator.generateTrigger("cron-trigger", "cron", "Run daily", "test-api-key");

			const callArgs = mockedGenerateText.mock.calls[0][0] as Record<string, unknown>;
			const prompt = callArgs.prompt as string;
			expect(prompt).toContain("cron expressions");
			expect(prompt).toContain("timezone");
		});

		it("should include webhook-specific guidance in prompt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_WEBHOOK_TRIGGER } as never);
			mockedValidateCode.mockReturnValue({ success: true, errors: [], warnings: [] });

			await generator.generateTrigger("webhook-trigger", "webhook", "Handle webhooks", "test-api-key");

			const callArgs = mockedGenerateText.mock.calls[0][0] as Record<string, unknown>;
			const prompt = callArgs.prompt as string;
			expect(prompt).toContain("signature verification");
		});
	});

	describe("validation feedback loop", () => {
		it("should retry when trigger fails compilation", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: INVALID_TRIGGER_NO_BASE } as never);
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_QUEUE_TRIGGER } as never);

			// First: compilation fails
			mockedValidateCode.mockReturnValueOnce({ success: false, errors: ["Syntax error"], warnings: [] });
			// Second: passes
			mockedValidateCode.mockReturnValueOnce({ success: true, errors: [], warnings: [] });

			const result = await generator.generateTrigger("kafka-queue", "queue", "Create a queue trigger", "test-api-key");

			expect(result.validationResult!.valid).toBe(true);
			expect(result.validationResult!.attempts).toBe(2);
			expect(mockedGenerateText).toHaveBeenCalledTimes(2);
		});

		it("should retry when trigger fails structural validation", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: INVALID_TRIGGER_NO_CONTEXT } as never);
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_QUEUE_TRIGGER } as never);

			// First: compilation passes but structural validation catches missing createContext
			mockedValidateCode.mockReturnValueOnce({ success: true, errors: [], warnings: [] });
			// Second: all passes
			mockedValidateCode.mockReturnValueOnce({ success: true, errors: [], warnings: [] });

			const result = await generator.generateTrigger("kafka-queue", "queue", "Create a queue trigger", "test-api-key");

			expect(result.validationResult!.valid).toBe(true);
			expect(result.validationResult!.attempts).toBe(2);
		});

		it("should include errors in feedback prompt on retry", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: INVALID_TRIGGER_NO_BASE } as never);
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_QUEUE_TRIGGER } as never);

			mockedValidateCode.mockReturnValueOnce({ success: false, errors: ["Missing TriggerBase import"], warnings: [] });
			mockedValidateCode.mockReturnValueOnce({ success: true, errors: [], warnings: [] });

			await generator.generateTrigger("kafka-queue", "queue", "Create a queue trigger", "test-api-key");

			const secondCallArgs = mockedGenerateText.mock.calls[1][0] as Record<string, unknown>;
			const prompt = secondCallArgs.prompt as string;
			expect(prompt).toContain("validation errors");
			expect(prompt).toContain("Missing TriggerBase import");
		});

		it("should exhaust all 3 attempts when trigger keeps failing", async () => {
			mockedGenerateText.mockResolvedValue({ text: INVALID_TRIGGER_NO_CONTEXT } as never);
			mockedValidateCode.mockReturnValue({ success: true, errors: [], warnings: [] });
			// Structural validation will catch the missing createContext every time

			const result = await generator.generateTrigger(
				"broken-trigger",
				"queue",
				"Create a broken trigger",
				"test-api-key",
			);

			expect(result.validationResult!.valid).toBe(false);
			expect(result.validationResult!.attempts).toBe(3);
			expect(mockedGenerateText).toHaveBeenCalledTimes(3);
		});

		it("should succeed on third attempt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: INVALID_TRIGGER_NO_BASE } as never);
			mockedGenerateText.mockResolvedValueOnce({ text: INVALID_TRIGGER_NO_METHODS } as never);
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_QUEUE_TRIGGER } as never);

			// Attempt 1: compilation fails
			mockedValidateCode.mockReturnValueOnce({ success: false, errors: ["Missing base class"], warnings: [] });
			// Attempt 2: compilation fails
			mockedValidateCode.mockReturnValueOnce({ success: false, errors: ["Missing methods"], warnings: [] });
			// Attempt 3: passes
			mockedValidateCode.mockReturnValueOnce({ success: true, errors: [], warnings: [] });

			const result = await generator.generateTrigger("kafka-queue", "queue", "Create a queue trigger", "test-api-key");

			expect(result.validationResult!.valid).toBe(true);
			expect(result.validationResult!.attempts).toBe(3);
		});
	});

	describe("markdown fence cleanup", () => {
		it("should strip markdown TypeScript fences from LLM response", async () => {
			const wrappedCode = `\`\`\`typescript\n${VALID_QUEUE_TRIGGER}\n\`\`\``;
			mockedGenerateText.mockResolvedValueOnce({ text: wrappedCode } as never);
			mockedValidateCode.mockReturnValue({ success: true, errors: [], warnings: [] });

			const result = await generator.generateTrigger("kafka-queue", "queue", "Create a queue trigger", "test-api-key");

			expect(result.code).not.toContain("```");
		});
	});

	describe("temperature and model configuration", () => {
		it("should use temperature 0.2 for deterministic output", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_QUEUE_TRIGGER } as never);
			mockedValidateCode.mockReturnValue({ success: true, errors: [], warnings: [] });

			await generator.generateTrigger("test-trigger", "queue", "Create a test trigger", "test-api-key");

			const callArgs = mockedGenerateText.mock.calls[0][0] as Record<string, unknown>;
			expect(callArgs.temperature).toBe(0.2);
		});

		it("should use the trigger system prompt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_QUEUE_TRIGGER } as never);
			mockedValidateCode.mockReturnValue({ success: true, errors: [], warnings: [] });

			await generator.generateTrigger("test-trigger", "queue", "Create a test trigger", "test-api-key");

			const callArgs = mockedGenerateText.mock.calls[0][0] as Record<string, unknown>;
			const system = callArgs.system as string;
			expect(system).toContain("TriggerBase");
			expect(system).toContain("createContext");
			expect(system).toContain("loadNodes");
		});
	});

	describe("analytics integration", () => {
		it("should include prompt version in validation result", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_QUEUE_TRIGGER } as never);
			mockedValidateCode.mockReturnValue({ success: true, errors: [], warnings: [] });

			const result = await generator.generateTrigger("test-trigger", "queue", "Create a test trigger", "test-api-key");

			expect(result.validationResult!.promptVersion).toContain("create-trigger@");
		});

		it("should include duration in validation result", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_QUEUE_TRIGGER } as never);
			mockedValidateCode.mockReturnValue({ success: true, errors: [], warnings: [] });

			const result = await generator.generateTrigger("test-trigger", "queue", "Create a test trigger", "test-api-key");

			expect(result.validationResult!.durationMs).toBeGreaterThanOrEqual(0);
		});
	});
});
