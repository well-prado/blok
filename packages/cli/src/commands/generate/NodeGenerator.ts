import * as fs from "node:fs";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import createFnNodeSystemPrompt from "./prompts/create-fn-node.system.js";
import createNodeSystemPrompt from "./prompts/create-node.system.js";
import * as CompilationValidator from "./validators/CompilationValidator.js";
import * as NodeValidator from "./validators/NodeValidator.js";
import type { NodeValidationContext } from "./validators/NodeValidator.js";

type NodeInformation = {
	nodeName: string;
	userPrompt: string;
	code: string;
	validationResult?: {
		valid: boolean;
		errors: string[];
		warnings: string[];
		attempts: number;
	};
};

export type { NodeInformation };

export default class NodeGenerator {
	private readonly MAX_VALIDATION_ATTEMPTS = 3;

	async generateNode(
		nodeName: string,
		userPrompt: string,
		apiKey: string,
		update = false,
		nodeStyle = "function",
	): Promise<NodeInformation> {
		const openai = createOpenAI({
			compatibility: "strict",
			apiKey: apiKey,
		});

		// Select the appropriate prompt based on node style
		const promptTemplate = nodeStyle === "function" ? createFnNodeSystemPrompt : createNodeSystemPrompt;
		let prompt = promptTemplate.prompt;
		let existingCode: string | null = null;

		// Register prompt content for hash tracking

		if (update) {
			// Read existing file and get the code
			const dirName = nodeName.toLowerCase().replace(/\s+/g, "-");
			const dirPath = process.cwd();
			const nodeDir = `${dirPath}/src/nodes`;
			const currentDir = `${nodeDir}/${dirName}`;
			const filePath = `${currentDir}/index.ts`;

			existingCode = fs.readFileSync(filePath, "utf8");
			prompt = `${promptTemplate.updatePrompt} \n\n ${existingCode}`;
		}

		// Generation with validation feedback loop
		let attempts = 0;
		let generatedCode = "";
		let validationErrors: string[] = [];
		let validationWarnings: string[] = [];
		let isValid = false;
		const allErrors: string[] = [];

		while (attempts < this.MAX_VALIDATION_ATTEMPTS && !isValid) {
			attempts++;

			// Adjust prompt based on previous validation errors
			let finalPrompt = userPrompt;
			if (attempts > 1 && validationErrors.length > 0) {
				finalPrompt = this.createFeedbackPrompt(userPrompt, generatedCode, validationErrors);
			}

			// Generate code
			const { text } = await generateText({
				model: openai("gpt-4o"),
				system: prompt,
				prompt: finalPrompt,
				temperature: 0.2,
			});

			generatedCode = text;

			// Validate the generated code
			const compilationResult = CompilationValidator.validateCode(generatedCode, `${nodeName}.ts`);

			validationErrors = compilationResult.errors;
			validationWarnings = compilationResult.warnings;
			isValid = compilationResult.success;

			// If compilation succeeds, perform structural validation
			if (isValid && nodeStyle === "function") {
				const context: NodeValidationContext = {
					filePath: `${nodeName}.ts`,
					nodeStyle: "function",
					content: generatedCode,
				};

				const structureResult = NodeValidator.validateFunctionFirstStructure(context);
				if (!structureResult.valid) {
					isValid = false;
					validationErrors.push(...structureResult.errors);
					validationWarnings.push(...structureResult.warnings);
				}
			}

			// Track errors across all attempts
			allErrors.push(...validationErrors);

			// Log attempt
			if (!isValid && attempts < this.MAX_VALIDATION_ATTEMPTS) {
				console.log(
					`⚠️  Validation failed (attempt ${attempts}/${this.MAX_VALIDATION_ATTEMPTS}). Retrying with feedback...`,
				);
			}
		}

		return {
			nodeName,
			userPrompt,
			code: generatedCode,
			validationResult: {
				valid: isValid,
				errors: validationErrors,
				warnings: validationWarnings,
				attempts,
			},
		};
	}

	/**
	 * Create a feedback prompt with semantic error analysis
	 */
	private createFeedbackPrompt(originalPrompt: string, previousCode: string, errors: string[]): string {
		// Analyze errors semantically for better guidance
		const analyzedErrors = errors.map((err, i) => {
			const guidance = this.getSemanticGuidance(err);
			return `${i + 1}. ${err}${guidance ? `\n   💡 Fix: ${guidance}` : ""}`;
		});

		const feedback = [
			originalPrompt,
			"",
			"❌ The previous generation had validation errors. Here's what went wrong and how to fix it:",
			"",
			...analyzedErrors,
			"",
			"Previous code:",
			"```typescript",
			previousCode,
			"```",
			"",
			"Please fix ALL the errors listed above and regenerate the complete code.",
			"Make sure to:",
			"- Import defineNode from '@blokjs/runner'",
			"- Import z from 'zod'",
			"- Import Context type from '@blokjs/shared'",
			"- Use z.object({...}) for input and output schemas",
			"- Make the execute function async",
			"- Export as default: export default defineNode({...})",
			"- Return a plain object matching the output schema (no BlokResponse)",
		].join("\n");

		return feedback;
	}

	/**
	 * Provide semantic guidance for common error patterns
	 */
	private getSemanticGuidance(error: string): string | null {
		const errorLower = error.toLowerCase();

		// Missing imports
		if (errorLower.includes("missing") && errorLower.includes("definenode")) {
			return "Add: import { defineNode } from '@blokjs/runner';";
		}
		if (errorLower.includes("missing") && errorLower.includes("zod")) {
			return "Add: import { z } from 'zod';";
		}
		if (errorLower.includes("cannot find") && errorLower.includes("definenode")) {
			return "Ensure defineNode is imported from '@blokjs/runner'";
		}

		// Schema issues
		if (errorLower.includes("z.object") || errorLower.includes("zod schema")) {
			return "Use z.object({...}) for both input and output schemas with proper Zod types";
		}

		// Execute function
		if (errorLower.includes("execute") && errorLower.includes("async")) {
			return "The execute function must be async: async execute(ctx, input) { ... }";
		}
		if (errorLower.includes("execute") && errorLower.includes("missing")) {
			return "Add execute property: async execute(ctx, input) { return { ... }; }";
		}

		// Export issues
		if (errorLower.includes("export") && errorLower.includes("default")) {
			return "Use: export default defineNode({...}) at the end of the file";
		}

		// Type errors
		if (errorLower.includes("type") && errorLower.includes("not assignable")) {
			return "Check that the return type of execute() matches the output Zod schema exactly";
		}

		// BlokResponse misuse
		if (errorLower.includes("blokresponse") || errorLower.includes("setsuccess")) {
			return "Do NOT use BlokResponse in function-first nodes. Just return a plain object.";
		}

		// Context access
		if (errorLower.includes("ctx.request") || errorLower.includes("context")) {
			return "Use ctx.request.body, ctx.request.query, ctx.request.params for HTTP data; ctx.vars for cross-node data";
		}

		// Compilation errors
		if (errorLower.includes("cannot find module") || errorLower.includes("module not found")) {
			return "Check import paths. Use '@blokjs/runner' for defineNode and '@blokjs/shared' for Context/GlobalError";
		}

		// Property access errors
		if (errorLower.includes("property") && errorLower.includes("does not exist")) {
			return "Verify property names match your Zod schemas. Use z.infer<typeof schema> for type inference.";
		}

		// Missing name/description
		if (errorLower.includes("name") && errorLower.includes("missing")) {
			return "Add a 'name' property with a kebab-case identifier, e.g., name: 'my-node'";
		}
		if (errorLower.includes("description") && errorLower.includes("missing")) {
			return "Add a 'description' property describing what the node does";
		}

		// Duplicate identifier
		if (errorLower.includes("duplicate identifier") || errorLower.includes("already declared")) {
			return "Remove duplicate variable/function declarations. Each identifier must be unique in its scope.";
		}

		// Implicit any
		if (errorLower.includes("implicit") && errorLower.includes("any")) {
			return "Add explicit type annotations. Use z.infer<typeof inputSchema> for input types.";
		}

		return null;
	}
}
