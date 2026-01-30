/**
 * NodeGenerator End-to-End Tests
 *
 * Tests the full generation pipeline with mocked LLM responses and validators.
 * Validates the 3-attempt validation loop, semantic error analysis,
 * and code cleanup without requiring an actual OpenAI API key.
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

// Mock NodeValidator
vi.mock("../validators/NodeValidator.js", () => ({
	validateFunctionFirstStructure: vi.fn(),
}));

import { generateText } from "ai";
import NodeGenerator from "../NodeGenerator.js";
import * as CompilationValidator from "../validators/CompilationValidator.js";
import * as NodeValidator from "../validators/NodeValidator.js";

const mockedGenerateText = vi.mocked(generateText);
const mockedValidateCode = vi.mocked(CompilationValidator.validateCode);
const mockedValidateStructure = vi.mocked(NodeValidator.validateFunctionFirstStructure);

// --- Mock LLM Responses ---

const VALID_FUNCTION_FIRST_NODE = `
import type { Context } from "@nanoservice-ts/shared";
import { z } from "zod";
import { defineNode } from "@nanoservice-ts/runner";

export default defineNode({
	name: "fetch-user",
	description: "Fetches user data from an external API",
	input: z.object({ userId: z.string() }),
	output: z.object({ id: z.string(), name: z.string(), email: z.string() }),
	async execute(ctx, input) {
		return { id: "1", name: "John", email: "john@example.com" };
	},
});
`;

const INVALID_NODE_MISSING_IMPORTS = `
export default defineNode({
	name: "broken-node",
	description: "Missing imports",
	input: z.object({ id: z.string() }),
	output: z.object({ result: z.string() }),
	async execute(ctx, input) { return { result: "hello" }; },
});
`;

const VALID_CLASS_BASED_NODE = `
import NanoService, { NanoServiceResponse, GlobalError } from "@nanoservice-ts/runner";
import type { Context } from "@nanoservice-ts/shared";

type InputType = { message: string; };

export default class HelloNode extends NanoService<InputType> {
	async handle(ctx: Context, inputs: InputType): Promise<NanoServiceResponse> {
		const response = new NanoServiceResponse();
		response.setSuccess({ greeting: inputs.message });
		return response;
	}
}
`;

// Helper to set up successful compilation + structure validation
function mockValidPass() {
	mockedValidateCode.mockReturnValue({ success: true, errors: [], warnings: [] });
	mockedValidateStructure.mockReturnValue({ valid: true, errors: [], warnings: [], suggestions: [] });
}

// Helper to set up failing compilation
function mockCompilationFail(errors: string[]) {
	mockedValidateCode.mockReturnValueOnce({ success: false, errors, warnings: [] });
}

describe("NodeGenerator E2E", () => {
	let generator: NodeGenerator;

	beforeEach(() => {
		generator = new NodeGenerator();
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("successful generation - first attempt", () => {
		it("should generate a valid function-first node on first attempt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_FUNCTION_FIRST_NODE } as never);
			mockValidPass();

			const result = await generator.generateNode(
				"fetch-user",
				"Create a node that fetches user data from an API",
				"test-api-key",
				false,
				"function",
			);

			expect(result.nodeName).toBe("fetch-user");
			expect(result.code).toBe(VALID_FUNCTION_FIRST_NODE);
			expect(result.validationResult).toBeDefined();
			expect(result.validationResult!.attempts).toBe(1);
			expect(result.validationResult!.valid).toBe(true);
			expect(mockedGenerateText).toHaveBeenCalledTimes(1);
		});

		it("should generate a valid class-based node on first attempt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_CLASS_BASED_NODE } as never);
			mockedValidateCode.mockReturnValue({ success: true, errors: [], warnings: [] });

			const result = await generator.generateNode(
				"hello-node",
				"Create a hello world node",
				"test-api-key",
				false,
				"class",
			);

			expect(result.nodeName).toBe("hello-node");
			expect(result.validationResult!.attempts).toBe(1);
			expect(result.validationResult!.valid).toBe(true);
		});

		it("should pass correct system prompt for function-first style", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_FUNCTION_FIRST_NODE } as never);
			mockValidPass();

			await generator.generateNode("test-node", "Create a test node", "test-api-key", false, "function");

			const callArgs = mockedGenerateText.mock.calls[0][0] as Record<string, unknown>;
			expect(callArgs.system).toContain("defineNode");
			expect(callArgs.system).toContain("function-first");
		});

		it("should pass correct system prompt for class-based style", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_CLASS_BASED_NODE } as never);
			mockedValidateCode.mockReturnValue({ success: true, errors: [], warnings: [] });

			await generator.generateNode("test-node", "Create a test node", "test-api-key", false, "class");

			const callArgs = mockedGenerateText.mock.calls[0][0] as Record<string, unknown>;
			expect(callArgs.system).toContain("NanoService");
		});

		it("should use temperature 0.2 for deterministic output", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_FUNCTION_FIRST_NODE } as never);
			mockValidPass();

			await generator.generateNode("test-node", "Create a test node", "test-api-key", false, "function");

			const callArgs = mockedGenerateText.mock.calls[0][0] as Record<string, unknown>;
			expect(callArgs.temperature).toBe(0.2);
		});

		it("should include prompt version in validation result", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_FUNCTION_FIRST_NODE } as never);
			mockValidPass();

			const result = await generator.generateNode("test-node", "Create a test node", "test-api-key", false, "function");

			expect(result.validationResult!.promptVersion).toContain("create-fn-node@");
		});

		it("should include duration in validation result", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_FUNCTION_FIRST_NODE } as never);
			mockValidPass();

			const result = await generator.generateNode("test-node", "Create a test node", "test-api-key", false, "function");

			expect(result.validationResult!.durationMs).toBeGreaterThanOrEqual(0);
		});
	});

	describe("validation feedback loop", () => {
		it("should retry with feedback on first failure and succeed on second attempt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: INVALID_NODE_MISSING_IMPORTS } as never);
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_FUNCTION_FIRST_NODE } as never);

			// First attempt: compilation fails
			mockCompilationFail(["Missing defineNode import"]);
			// Second attempt: passes
			mockValidPass();

			const result = await generator.generateNode(
				"fetch-user",
				"Create a node that fetches user data",
				"test-api-key",
				false,
				"function",
			);

			expect(result.validationResult!.attempts).toBe(2);
			expect(result.validationResult!.valid).toBe(true);
			expect(result.code).toBe(VALID_FUNCTION_FIRST_NODE);
			expect(mockedGenerateText).toHaveBeenCalledTimes(2);
		});

		it("should include error feedback in retry prompt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: INVALID_NODE_MISSING_IMPORTS } as never);
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_FUNCTION_FIRST_NODE } as never);

			mockCompilationFail(["Missing defineNode import"]);
			mockValidPass();

			await generator.generateNode("test-node", "Create a test node", "test-api-key", false, "function");

			const secondCallArgs = mockedGenerateText.mock.calls[1][0] as Record<string, unknown>;
			const prompt = secondCallArgs.prompt as string;
			expect(prompt).toContain("validation errors");
			expect(prompt).toContain("Previous code:");
			expect(prompt).toContain("Missing defineNode import");
		});

		it("should exhaust all 3 attempts when code keeps failing", async () => {
			mockedGenerateText.mockResolvedValue({ text: INVALID_NODE_MISSING_IMPORTS } as never);
			mockedValidateCode.mockReturnValue({ success: false, errors: ["Missing imports"], warnings: [] });

			const result = await generator.generateNode(
				"broken-node",
				"Create something broken",
				"test-api-key",
				false,
				"function",
			);

			expect(result.validationResult!.valid).toBe(false);
			expect(result.validationResult!.attempts).toBe(3);
			expect(mockedGenerateText).toHaveBeenCalledTimes(3);
		});

		it("should succeed on third attempt", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: INVALID_NODE_MISSING_IMPORTS } as never);
			mockedGenerateText.mockResolvedValueOnce({ text: INVALID_NODE_MISSING_IMPORTS } as never);
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_FUNCTION_FIRST_NODE } as never);

			// Attempts 1-2 fail, attempt 3 passes
			mockCompilationFail(["Missing imports"]);
			mockCompilationFail(["Still missing imports"]);
			mockValidPass();

			const result = await generator.generateNode(
				"fetch-user",
				"Create a user fetcher",
				"test-api-key",
				false,
				"function",
			);

			expect(result.validationResult!.attempts).toBe(3);
			expect(result.validationResult!.valid).toBe(true);
			expect(result.code).toBe(VALID_FUNCTION_FIRST_NODE);
		});
	});

	describe("structural validation for function-first", () => {
		it("should detect missing defineNode via structural validation", async () => {
			mockedGenerateText.mockResolvedValue({ text: "const x = 1;" } as never);
			// Compilation passes but structure fails
			mockedValidateCode.mockReturnValue({ success: true, errors: [], warnings: [] });
			mockedValidateStructure.mockReturnValue({
				valid: false,
				errors: ["Missing defineNode import from @nanoservice-ts/runner"],
				warnings: [],
				suggestions: [],
			});

			const result = await generator.generateNode("test-node", "Create test node", "test-api-key", false, "function");

			expect(result.validationResult!.valid).toBe(false);
			expect(result.validationResult!.errors.some((e: string) => e.toLowerCase().includes("definenode"))).toBe(true);
		});

		it("should skip structural validation for class-based style", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_CLASS_BASED_NODE } as never);
			mockedValidateCode.mockReturnValue({ success: true, errors: [], warnings: [] });

			const result = await generator.generateNode("test-node", "Create test node", "test-api-key", false, "class");

			expect(result.validationResult!.valid).toBe(true);
			// NodeValidator.validateFunctionFirstStructure should NOT be called for class style
			expect(mockedValidateStructure).not.toHaveBeenCalled();
		});
	});

	describe("code with markdown fences", () => {
		it("should return code as-is from LLM (cleanup happens at CLI layer)", async () => {
			const wrappedCode = "```typescript\n" + VALID_FUNCTION_FIRST_NODE + "\n```";
			mockedGenerateText.mockResolvedValueOnce({ text: wrappedCode } as never);
			mockValidPass();

			const result = await generator.generateNode(
				"fetch-user",
				"Create a user fetcher",
				"test-api-key",
				false,
				"function",
			);

			expect(result.code).toBe(wrappedCode);
		});
	});

	describe("default node style", () => {
		it("should default to function style when no style specified", async () => {
			mockedGenerateText.mockResolvedValueOnce({ text: VALID_FUNCTION_FIRST_NODE } as never);
			mockValidPass();

			await generator.generateNode("test-node", "Create a test node", "test-api-key", false);

			const callArgs = mockedGenerateText.mock.calls[0][0] as Record<string, unknown>;
			expect(callArgs.system).toContain("defineNode");
		});
	});
});
