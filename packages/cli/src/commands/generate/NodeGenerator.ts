import * as fs from "node:fs";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import createNodeSystemPrompt from "./prompts/create-node.system.js";
import createFnNodeSystemPrompt from "./prompts/create-fn-node.system.js";
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

	async generateNode(nodeName: string, userPrompt: string, apiKey: string, update = false, nodeStyle = "function"): Promise<NodeInformation> {
		const openai = createOpenAI({
			compatibility: "strict",
			apiKey: apiKey,
		});

		// Select the appropriate prompt based on node style
		const promptTemplate = nodeStyle === "function" ? createFnNodeSystemPrompt : createNodeSystemPrompt;
		let prompt = promptTemplate.prompt;
		let existingCode: string | null = null;

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

			// Log attempt
			if (!isValid && attempts < this.MAX_VALIDATION_ATTEMPTS) {
				console.log(`⚠️  Validation failed (attempt ${attempts}/${this.MAX_VALIDATION_ATTEMPTS}). Retrying with feedback...`);
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
	 * Create a feedback prompt based on validation errors
	 */
	private createFeedbackPrompt(originalPrompt: string, previousCode: string, errors: string[]): string {
		const feedback = [
			originalPrompt,
			"",
			"❌ The previous generation had validation errors:",
			...errors.map((err, i) => `${i + 1}. ${err}`),
			"",
			"Previous code:",
			"```typescript",
			previousCode,
			"```",
			"",
			"Please fix these errors and regenerate the code.",
		].join("\n");

		return feedback;
	}
}
