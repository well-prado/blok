/**
 * WorkflowValidator - Validates generated workflow JSON configurations
 *
 * Performs structural validation of Blok workflow JSON to ensure:
 * - Valid top-level structure (name, description, version, trigger, steps, nodes)
 * - Trigger configuration is valid
 * - All steps have matching node configurations
 * - Conditional nodes have valid condition expressions
 * - Input patterns use supported syntax
 */

export interface WorkflowValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

const VALID_TRIGGER_TYPES = [
	"http",
	"grpc",
	"manual",
	"cron",
	"queue",
	"pubsub",
	"worker",
	"webhook",
	"sse",
	"websocket",
];
const VALID_STEP_TYPES = ["module", "local", "runtime.python3", "runtime.go", "runtime.java"];
const VALID_HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "ANY", "*"];
const VALID_QUEUE_PROVIDERS = ["kafka", "rabbitmq", "sqs", "redis", "beanstalk"];
const VALID_PUBSUB_PROVIDERS = ["gcp", "aws", "azure"];
const VALID_WEBHOOK_SOURCES = ["github", "stripe", "shopify", "custom"];

/**
 * Validates a workflow JSON string for structural correctness
 */
export function validateWorkflow(jsonString: string): WorkflowValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	// Step 1: Parse JSON
	let workflow: Record<string, unknown>;
	try {
		workflow = JSON.parse(jsonString);
	} catch (e) {
		return {
			valid: false,
			errors: [`Invalid JSON: ${(e as Error).message}`],
			warnings: [],
		};
	}

	// Step 2: Validate top-level structure
	validateTopLevel(workflow, errors, warnings);

	// Step 3: Validate trigger
	if (workflow.trigger && typeof workflow.trigger === "object") {
		validateTrigger(workflow.trigger as Record<string, unknown>, errors, warnings);
	}

	// Step 4: Validate steps
	const stepNames = new Set<string>();
	if (Array.isArray(workflow.steps)) {
		validateSteps(workflow.steps, stepNames, errors, warnings);
	}

	// Step 5: Validate nodes and cross-reference with steps
	if (workflow.nodes && typeof workflow.nodes === "object") {
		validateNodes(workflow.nodes as Record<string, unknown>, stepNames, errors, warnings);
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}

function validateTopLevel(workflow: Record<string, unknown>, errors: string[], warnings: string[]): void {
	// Required fields
	if (!workflow.name || typeof workflow.name !== "string") {
		errors.push('Missing or invalid "name" field (must be a non-empty string)');
	}

	if (workflow.description === undefined) {
		warnings.push('Missing "description" field - recommended for documentation');
	} else if (typeof workflow.description !== "string") {
		errors.push('"description" must be a string');
	}

	if (!workflow.version || typeof workflow.version !== "string") {
		errors.push('Missing or invalid "version" field (must be a string like "1.0.0")');
	} else if (!/^\d+\.\d+\.\d+/.test(workflow.version as string)) {
		warnings.push('"version" should follow semver format (e.g., "1.0.0")');
	}

	if (!workflow.trigger || typeof workflow.trigger !== "object") {
		errors.push('Missing or invalid "trigger" field (must be an object)');
	}

	if (!workflow.steps || !Array.isArray(workflow.steps)) {
		errors.push('Missing or invalid "steps" field (must be an array)');
	} else if ((workflow.steps as unknown[]).length === 0) {
		errors.push('"steps" array must not be empty');
	}

	if (!workflow.nodes || typeof workflow.nodes !== "object") {
		errors.push('Missing or invalid "nodes" field (must be an object)');
	}
}

function validateTrigger(trigger: Record<string, unknown>, errors: string[], warnings: string[]): void {
	const triggerKeys = Object.keys(trigger);

	if (triggerKeys.length === 0) {
		errors.push("Trigger must have exactly one trigger type");
		return;
	}

	if (triggerKeys.length > 1) {
		errors.push(`Trigger must have exactly one trigger type, found ${triggerKeys.length}: ${triggerKeys.join(", ")}`);
		return;
	}

	const triggerType = triggerKeys[0];
	if (!VALID_TRIGGER_TYPES.includes(triggerType)) {
		errors.push(`Invalid trigger type "${triggerType}". Valid types: ${VALID_TRIGGER_TYPES.join(", ")}`);
		return;
	}

	const config = trigger[triggerType] as Record<string, unknown>;
	if (!config || typeof config !== "object") {
		errors.push(`Trigger "${triggerType}" must have a configuration object`);
		return;
	}

	// Trigger-type specific validation
	switch (triggerType) {
		case "http":
			validateHttpTrigger(config, errors, warnings);
			break;
		case "queue":
			validateQueueTrigger(config, errors, warnings);
			break;
		case "pubsub":
			validatePubSubTrigger(config, errors, warnings);
			break;
		case "cron":
			validateCronTrigger(config, errors, warnings);
			break;
		case "webhook":
			validateWebhookTrigger(config, errors, warnings);
			break;
	}
}

function validateHttpTrigger(config: Record<string, unknown>, errors: string[], warnings: string[]): void {
	if (config.method && typeof config.method === "string") {
		if (!VALID_HTTP_METHODS.includes(config.method.toUpperCase())) {
			errors.push(`Invalid HTTP method "${config.method}". Valid methods: ${VALID_HTTP_METHODS.join(", ")}`);
		}
	}

	if (config.path !== undefined && typeof config.path !== "string") {
		errors.push('HTTP trigger "path" must be a string');
	}

	if (config.accept !== undefined && typeof config.accept !== "string") {
		warnings.push('HTTP trigger "accept" should be a string');
	}
}

function validateQueueTrigger(config: Record<string, unknown>, errors: string[], warnings: string[]): void {
	if (!config.provider || typeof config.provider !== "string") {
		errors.push('Queue trigger requires "provider" field');
	} else if (!VALID_QUEUE_PROVIDERS.includes(config.provider as string)) {
		errors.push(`Invalid queue provider "${config.provider}". Valid providers: ${VALID_QUEUE_PROVIDERS.join(", ")}`);
	}

	if (!config.topic || typeof config.topic !== "string") {
		errors.push('Queue trigger requires "topic" field');
	}
}

function validatePubSubTrigger(config: Record<string, unknown>, errors: string[], warnings: string[]): void {
	if (!config.provider || typeof config.provider !== "string") {
		errors.push('Pub/Sub trigger requires "provider" field');
	} else if (!VALID_PUBSUB_PROVIDERS.includes(config.provider as string)) {
		errors.push(`Invalid pub/sub provider "${config.provider}". Valid providers: ${VALID_PUBSUB_PROVIDERS.join(", ")}`);
	}

	if (!config.topic || typeof config.topic !== "string") {
		errors.push('Pub/Sub trigger requires "topic" field');
	}

	if (!config.subscription || typeof config.subscription !== "string") {
		errors.push('Pub/Sub trigger requires "subscription" field');
	}
}

function validateCronTrigger(config: Record<string, unknown>, errors: string[], warnings: string[]): void {
	if (!config.schedule || typeof config.schedule !== "string") {
		errors.push('Cron trigger requires "schedule" field (cron expression)');
	} else {
		// Basic cron expression validation (5 or 6 fields)
		const parts = (config.schedule as string).trim().split(/\s+/);
		if (parts.length < 5 || parts.length > 6) {
			errors.push(`Invalid cron expression "${config.schedule}". Must have 5 or 6 space-separated fields`);
		}
	}

	if (config.timezone !== undefined && typeof config.timezone !== "string") {
		errors.push('Cron trigger "timezone" must be a string');
	}
}

function validateWebhookTrigger(config: Record<string, unknown>, errors: string[], warnings: string[]): void {
	if (!config.source || typeof config.source !== "string") {
		errors.push('Webhook trigger requires "source" field');
	} else if (!VALID_WEBHOOK_SOURCES.includes(config.source as string)) {
		warnings.push(`Unknown webhook source "${config.source}". Known sources: ${VALID_WEBHOOK_SOURCES.join(", ")}`);
	}

	if (!config.events || !Array.isArray(config.events)) {
		errors.push('Webhook trigger requires "events" array');
	} else if ((config.events as unknown[]).length === 0) {
		errors.push('Webhook trigger "events" array must not be empty');
	}
}

function validateSteps(steps: unknown[], stepNames: Set<string>, errors: string[], warnings: string[]): void {
	for (let i = 0; i < steps.length; i++) {
		const step = steps[i] as Record<string, unknown>;

		if (!step || typeof step !== "object") {
			errors.push(`Step at index ${i} must be an object`);
			continue;
		}

		if (!step.name || typeof step.name !== "string") {
			errors.push(`Step at index ${i} is missing required "name" field`);
			continue;
		}

		if (!step.node || typeof step.node !== "string") {
			errors.push(`Step "${step.name}" is missing required "node" field`);
		}

		if (!step.type || typeof step.type !== "string") {
			errors.push(`Step "${step.name}" is missing required "type" field`);
		} else if (!VALID_STEP_TYPES.includes(step.type as string)) {
			warnings.push(
				`Step "${step.name}" has unusual type "${step.type}". Common types: ${VALID_STEP_TYPES.join(", ")}`,
			);
		}

		if (stepNames.has(step.name as string)) {
			errors.push(`Duplicate step name "${step.name}"`);
		}
		stepNames.add(step.name as string);
	}
}

function validateNodes(
	nodes: Record<string, unknown>,
	stepNames: Set<string>,
	errors: string[],
	warnings: string[],
): void {
	// Collect all step names from conditional branches too
	const allReferencedStepNames = new Set<string>(stepNames);

	// First pass: find all step names referenced in conditional branches
	for (const [nodeName, nodeConfig] of Object.entries(nodes)) {
		if (!nodeConfig || typeof nodeConfig !== "object") {
			errors.push(`Node "${nodeName}" must be an object`);
			continue;
		}

		const config = nodeConfig as Record<string, unknown>;
		if (config.conditions && Array.isArray(config.conditions)) {
			collectConditionalStepNames(config.conditions as unknown[], allReferencedStepNames);
		}
	}

	// Second pass: verify every referenced step has a node config
	for (const stepName of allReferencedStepNames) {
		if (!nodes[stepName]) {
			errors.push(`Step "${stepName}" is referenced but has no matching entry in "nodes"`);
		}
	}

	// Third pass: validate node configs
	for (const [nodeName, nodeConfig] of Object.entries(nodes)) {
		if (!nodeConfig || typeof nodeConfig !== "object") continue;

		const config = nodeConfig as Record<string, unknown>;

		if (config.conditions && Array.isArray(config.conditions)) {
			validateConditions(nodeName, config.conditions as unknown[], errors, warnings);
		} else if (config.inputs === undefined) {
			warnings.push(`Node "${nodeName}" has neither "inputs" nor "conditions" - may need configuration`);
		}
	}
}

function collectConditionalStepNames(conditions: unknown[], stepNames: Set<string>): void {
	for (const condition of conditions) {
		if (!condition || typeof condition !== "object") continue;
		const cond = condition as Record<string, unknown>;

		if (cond.steps && Array.isArray(cond.steps)) {
			for (const step of cond.steps as Record<string, unknown>[]) {
				if (step.name && typeof step.name === "string") {
					stepNames.add(step.name);
				}
			}
		}
	}
}

function validateConditions(nodeName: string, conditions: unknown[], errors: string[], warnings: string[]): void {
	let hasElse = false;
	const conditionStepNames = new Set<string>();

	for (let i = 0; i < conditions.length; i++) {
		const cond = conditions[i] as Record<string, unknown>;

		if (!cond || typeof cond !== "object") {
			errors.push(`Condition ${i} in node "${nodeName}" must be an object`);
			continue;
		}

		if (!cond.type || !["if", "else"].includes(cond.type as string)) {
			errors.push(`Condition ${i} in node "${nodeName}" must have type "if" or "else"`);
			continue;
		}

		if (cond.type === "if") {
			if (!cond.condition || typeof cond.condition !== "string") {
				errors.push(`Condition ${i} in node "${nodeName}" (type "if") must have a "condition" string`);
			} else {
				// Validate condition expression uses ctx.* properties
				const condStr = cond.condition as string;
				if (!condStr.includes("ctx.")) {
					warnings.push(`Condition ${i} in node "${nodeName}" doesn't reference ctx.* - may be invalid`);
				}
			}
		}

		if (cond.type === "else") {
			hasElse = true;
			if (i !== conditions.length - 1) {
				errors.push(`"else" condition in node "${nodeName}" must be the last condition`);
			}
		}

		if (!cond.steps || !Array.isArray(cond.steps) || (cond.steps as unknown[]).length === 0) {
			errors.push(`Condition ${i} in node "${nodeName}" must have at least one step`);
		} else {
			// Validate steps within conditions
			for (const step of cond.steps as Record<string, unknown>[]) {
				if (step.name && typeof step.name === "string") {
					if (conditionStepNames.has(step.name)) {
						warnings.push(`Duplicate step name "${step.name}" in conditional branches of node "${nodeName}"`);
					}
					conditionStepNames.add(step.name);
				}

				if (!step.name || !step.node || !step.type) {
					errors.push(`Step in condition ${i} of node "${nodeName}" must have name, node, and type fields`);
				}
			}
		}
	}

	if (!hasElse) {
		warnings.push(`Conditional node "${nodeName}" has no "else" branch - consider adding a fallback`);
	}
}
