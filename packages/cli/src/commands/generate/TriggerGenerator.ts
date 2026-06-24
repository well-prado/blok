import * as fs from "node:fs";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import createTriggerSystemPrompt from "./prompts/create-trigger.system.js";
import * as CompilationValidator from "./validators/CompilationValidator.js";

export type TriggerInformation = {
	triggerName: string;
	triggerType: string;
	userPrompt: string;
	code: string;
	validationResult?: {
		valid: boolean;
		errors: string[];
		warnings: string[];
		attempts: number;
	};
};

export default class TriggerGenerator {
	private readonly MAX_VALIDATION_ATTEMPTS = 3;

	async generateTrigger(
		triggerName: string,
		triggerType: string,
		userPrompt: string,
		apiKey: string,
		update = false,
		existingTriggerPath?: string,
	): Promise<TriggerInformation> {
		const openai = createOpenAI({
			compatibility: "strict",
			apiKey: apiKey,
		});

		let prompt = createTriggerSystemPrompt.prompt;

		// Register prompt content for hash tracking

		// If updating, include existing trigger code
		if (update && existingTriggerPath) {
			const existingContent = fs.readFileSync(existingTriggerPath, "utf8");
			prompt = `${createTriggerSystemPrompt.updatePrompt}\n\n${existingContent}`;
		}

		// Enhance user prompt with trigger type context
		const enhancedPrompt = this.buildEnhancedPrompt(userPrompt, triggerType, triggerName);

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
			let finalPrompt = enhancedPrompt;
			if (attempts > 1 && validationErrors.length > 0) {
				finalPrompt = this.createFeedbackPrompt(enhancedPrompt, generatedCode, validationErrors);
			}

			// Generate trigger code
			const { text } = await generateText({
				model: openai("gpt-4o"),
				system: prompt,
				prompt: finalPrompt,
				temperature: 0.2,
			});

			// Clean up response
			generatedCode = text.replace(/^```typescript\s*([\s\S]*?)\s*```$/gm, "$1").trim();

			// Validate the generated code (TypeScript compilation check)
			const compilationResult = CompilationValidator.validateCode(generatedCode, `${triggerName}-trigger.ts`);
			validationErrors = compilationResult.errors;
			validationWarnings = compilationResult.warnings;
			isValid = compilationResult.success;

			// Structural validation for triggers
			if (isValid) {
				const structureResult = this.validateTriggerStructure(generatedCode);
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
					`⚠️  Trigger validation failed (attempt ${attempts}/${this.MAX_VALIDATION_ATTEMPTS}). Retrying with feedback...`,
				);
			}
		}

		return {
			triggerName,
			triggerType,
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
	 * Validate trigger structure
	 */
	private validateTriggerStructure(code: string): { valid: boolean; errors: string[]; warnings: string[] } {
		const errors: string[] = [];
		const warnings: string[] = [];

		// Check for TriggerBase extension
		if (!code.includes("extends TriggerBase") && !code.includes("extends") && !code.includes("TriggerBase")) {
			errors.push("Trigger must extend TriggerBase");
		}

		// Check for TriggerBase import
		if (!code.includes("TriggerBase") && !code.includes("@blokjs/runner")) {
			errors.push("Missing TriggerBase import from @blokjs/runner");
		}

		// Check for loadNodes method
		if (!code.includes("loadNodes")) {
			errors.push("Missing loadNodes() method");
		}

		// Check for loadWorkflows method
		if (!code.includes("loadWorkflows")) {
			errors.push("Missing loadWorkflows() method");
		}

		// Check for createContext usage
		if (!code.includes("createContext")) {
			errors.push("Must use this.createContext() to create workflow context");
		}

		// Check for ctx.request population
		if (
			!code.includes(".request") ||
			(!code.includes("ctx.request") && !code.includes("context.request") && !code.includes(".request ="))
		) {
			warnings.push("Should populate ctx.request with event data");
		}

		// Check for export default
		if (!code.includes("export default")) {
			warnings.push("Consider exporting the trigger class as default");
		}

		// Check for constructor with super()
		if (code.includes("constructor") && !code.includes("super()")) {
			errors.push("Constructor must call super()");
		}

		return {
			valid: errors.length === 0,
			errors,
			warnings,
		};
	}

	/**
	 * Build an enhanced prompt with trigger type context
	 */
	private buildEnhancedPrompt(userPrompt: string, triggerType: string, triggerName: string): string {
		const parts = [
			`Create a trigger named "${triggerName}" of type "${triggerType}" with the following requirements:`,
			"",
			userPrompt,
			"",
			`IMPORTANT: This trigger MUST handle the "${triggerType}" trigger type.`,
		];

		switch (triggerType) {
			case "queue":
				parts.push("The trigger should connect to a message queue broker (Kafka, RabbitMQ, SQS, or Redis/BullMQ).");
				parts.push("It should consume messages, match them to workflows, create context, and execute workflows.");
				parts.push("Include proper ack/nack handling and dead letter queue support.");
				break;
			case "pubsub":
				parts.push("The trigger should connect to a pub/sub provider (GCP, AWS SNS, or Azure Service Bus).");
				parts.push("It should subscribe to topics, receive messages, and execute matching workflows.");
				parts.push("Include proper acknowledgment and message filtering.");
				break;
			case "cron":
				parts.push("The trigger should schedule recurring jobs using cron expressions.");
				parts.push("Include timezone support, overlap prevention, and manual trigger capability.");
				break;
			case "webhook":
				parts.push("The trigger should expose HTTP endpoints for receiving webhook events.");
				parts.push("Include signature verification for common providers (GitHub, Stripe, Shopify).");
				parts.push("Support event type filtering with wildcards.");
				break;
			case "websocket":
				parts.push("The trigger should create a WebSocket server for real-time bidirectional communication.");
				parts.push("Include room/channel management, connection tracking, and authentication middleware.");
				break;
			case "sse":
				parts.push("The trigger should create SSE (Server-Sent Events) endpoints.");
				parts.push("Include channel management, event formatting, Last-Event-ID replay support, and heartbeat.");
				break;
			default:
				parts.push(`Implement a custom trigger for the "${triggerType}" event source.`);
				break;
		}

		return parts.join("\n");
	}

	/**
	 * Create a feedback prompt with semantic error analysis
	 */
	private createFeedbackPrompt(originalPrompt: string, previousCode: string, errors: string[]): string {
		const analyzedErrors = errors.map((err, i) => {
			const guidance = this.getSemanticGuidance(err);
			return `${i + 1}. ${err}${guidance ? `\n   Fix: ${guidance}` : ""}`;
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
			"Please fix ALL the errors listed above and regenerate the complete trigger code.",
			"Make sure to:",
			"- Extend TriggerBase from @blokjs/runner",
			"- Include loadNodes() and loadWorkflows() methods",
			"- Use this.createContext() to create Context objects",
			"- Call super() in the constructor",
			"- Populate ctx.request with event data before executing workflows",
			"- Export the class as default: export default class <Name>Trigger extends TriggerBase",
			"- Use Object.keys(workflowModel.trigger) to extract trigger config",
		].join("\n");

		return feedback;
	}

	/**
	 * Provide semantic guidance for common trigger error patterns
	 */
	private getSemanticGuidance(error: string): string | null {
		const errorLower = error.toLowerCase();

		if (errorLower.includes("triggerbase") && (errorLower.includes("extend") || errorLower.includes("missing"))) {
			return "import { TriggerBase } from '@blokjs/runner'; class MyTrigger extends TriggerBase { ... }";
		}
		if (errorLower.includes("loadnodes") && errorLower.includes("missing")) {
			return "Add: private loadNodes(): void { this.nodeMap.nodes = new NodeMap(); ... }";
		}
		if (errorLower.includes("loadworkflows") && errorLower.includes("missing")) {
			return "Add: private loadWorkflows(): void { this.nodeMap.workflows = workflows; }";
		}
		if (errorLower.includes("createcontext")) {
			return "Use this.createContext(undefined, workflowModel.path) to create context for each workflow execution";
		}
		if (errorLower.includes("super()")) {
			return "Add super(); as the first line in constructor()";
		}
		if (errorLower.includes("ctx.request") || errorLower.includes("event data")) {
			return "Set ctx.request = { body: messageData, headers: {}, query: {}, params: {} } before executing workflow";
		}
		if (errorLower.includes("cannot find module") || errorLower.includes("module not found")) {
			return "Use '@blokjs/runner' for TriggerBase, Runner, NodeMap and '@blokjs/shared' for Context, DefaultLogger";
		}
		if (errorLower.includes("export") && errorLower.includes("default")) {
			return "Use: export default class <Name>Trigger extends TriggerBase { ... }";
		}

		return null;
	}
}
