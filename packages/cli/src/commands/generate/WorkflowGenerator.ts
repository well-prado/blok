import * as fs from "node:fs";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import createWorkflowSystemPrompt from "./prompts/create-workflow.system.js";
import * as WorkflowValidator from "./validators/WorkflowValidator.js";

export type WorkflowInformation = {
	workflowName: string;
	userPrompt: string;
	json: string;
	triggerType: string;
	validationResult?: {
		valid: boolean;
		errors: string[];
		warnings: string[];
		attempts: number;
	};
};

export default class WorkflowGenerator {
	private readonly MAX_VALIDATION_ATTEMPTS = 3;

	async generateWorkflow(
		workflowName: string,
		userPrompt: string,
		apiKey: string,
		triggerType: string,
		update = false,
		existingWorkflowPath?: string,
	): Promise<WorkflowInformation> {
		const openai = createOpenAI({
			compatibility: "strict",
			apiKey: apiKey,
		});

		let prompt = createWorkflowSystemPrompt.prompt;

		// Register prompt content for hash tracking

		// If updating, include existing workflow
		if (update && existingWorkflowPath) {
			const existingContent = fs.readFileSync(existingWorkflowPath, "utf8");
			prompt = `${createWorkflowSystemPrompt.updatePrompt}\n\n${existingContent}`;
		}

		// Enhance user prompt with trigger type context
		const enhancedPrompt = this.buildEnhancedPrompt(userPrompt, triggerType, workflowName);

		// Generation with validation feedback loop
		let attempts = 0;
		let generatedJson = "";
		let validationErrors: string[] = [];
		let validationWarnings: string[] = [];
		let isValid = false;
		const allErrors: string[] = [];

		while (attempts < this.MAX_VALIDATION_ATTEMPTS && !isValid) {
			attempts++;

			// Adjust prompt based on previous validation errors
			let finalPrompt = enhancedPrompt;
			if (attempts > 1 && validationErrors.length > 0) {
				finalPrompt = this.createFeedbackPrompt(enhancedPrompt, generatedJson, validationErrors);
			}

			// Generate workflow JSON
			const { text } = await generateText({
				model: openai("gpt-4o"),
				system: prompt,
				prompt: finalPrompt,
				temperature: 0.2,
			});

			// Clean up response (remove markdown fences if present)
			generatedJson = text.replace(/^```json\s*([\s\S]*?)\s*```$/gm, "$1").trim();

			// Validate the generated workflow
			const result = WorkflowValidator.validateWorkflow(generatedJson);

			validationErrors = result.errors;
			validationWarnings = result.warnings;
			isValid = result.valid;

			// Track errors across all attempts
			allErrors.push(...validationErrors);

			// Log attempt
			if (!isValid && attempts < this.MAX_VALIDATION_ATTEMPTS) {
				console.log(
					`⚠️  Workflow validation failed (attempt ${attempts}/${this.MAX_VALIDATION_ATTEMPTS}). Retrying with feedback...`,
				);
			}
		}

		return {
			workflowName,
			userPrompt,
			json: generatedJson,
			triggerType,
			validationResult: {
				valid: isValid,
				errors: validationErrors,
				warnings: validationWarnings,
				attempts,
			},
		};
	}

	/**
	 * Build an enhanced prompt with trigger type context
	 */
	private buildEnhancedPrompt(userPrompt: string, triggerType: string, workflowName: string): string {
		const parts = [`Create a workflow named "${workflowName}" with the following requirements:`, "", userPrompt];

		if (triggerType && triggerType !== "auto") {
			parts.push("");
			parts.push(`IMPORTANT: This workflow MUST use the "${triggerType}" trigger type.`);

			switch (triggerType) {
				case "http":
					parts.push("Configure the HTTP trigger with appropriate method, path, and accept settings.");
					break;
				case "queue":
					parts.push("Configure the queue trigger with appropriate provider, topic, and consumer group settings.");
					break;
				case "pubsub":
					parts.push("Configure the pub/sub trigger with appropriate provider, topic, and subscription settings.");
					break;
				case "cron":
					parts.push("Configure the cron trigger with appropriate schedule expression and timezone.");
					break;
				case "webhook":
					parts.push("Configure the webhook trigger with appropriate source, events, and optional secret.");
					break;
				case "websocket":
					parts.push("Configure the WebSocket trigger with appropriate events and connection settings.");
					break;
				case "sse":
					parts.push("Configure the SSE trigger with appropriate events and channel settings.");
					break;
			}
		}

		return parts.join("\n");
	}

	/**
	 * Create a feedback prompt based on validation errors
	 */
	private createFeedbackPrompt(originalPrompt: string, previousJson: string, errors: string[]): string {
		const feedback = [
			originalPrompt,
			"",
			"❌ The previous generation had validation errors:",
			...errors.map((err, i) => `${i + 1}. ${err}`),
			"",
			"Previous workflow JSON:",
			"```json",
			previousJson,
			"```",
			"",
			"Please fix these errors and regenerate the workflow JSON. Common fixes:",
			"- Ensure every step name has a matching entry in the nodes object",
			"- Ensure the trigger has exactly one trigger type with valid configuration",
			"- Ensure condition expressions use ctx.* properties",
			"- Ensure all conditional branches have name, node, and type fields",
			"- Add an else branch to conditional routing for error handling",
		].join("\n");

		return feedback;
	}
}
