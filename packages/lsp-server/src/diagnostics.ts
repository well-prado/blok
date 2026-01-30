import { type Diagnostic, DiagnosticSeverity, Position, Range } from "vscode-languageserver";
import { VALID_HTTP_METHODS, VALID_RUNTIMES, VALID_STEP_TYPES, VALID_TRIGGERS, type WorkflowJson } from "./constants";

/**
 * Provides workflow validation diagnostics for the LSP server.
 *
 * Validates:
 * - Required fields (name, version, trigger, steps, nodes)
 * - Version format (semver)
 * - Trigger configuration (type-specific validation)
 * - Step structure (name, node, type)
 * - Node configuration references
 * - Unused nodes
 * - Runtime field validation
 */
export function validateWorkflow(text: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	let workflow: WorkflowJson;
	try {
		workflow = JSON.parse(text);
	} catch {
		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			range: createRange(0, 0, 0, 1),
			message: "Invalid JSON: failed to parse workflow file",
			source: "blok",
		});
		return diagnostics;
	}

	if (typeof workflow !== "object" || workflow === null || Array.isArray(workflow)) {
		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			range: createRange(0, 0, 0, 1),
			message: "Workflow must be a JSON object",
			source: "blok",
		});
		return diagnostics;
	}

	validateRequiredFields(text, workflow, diagnostics);
	validateVersion(text, workflow, diagnostics);
	validateTrigger(text, workflow, diagnostics);
	validateSteps(text, workflow, diagnostics);
	validateNodeReferences(text, workflow, diagnostics);

	return diagnostics;
}

function validateRequiredFields(text: string, workflow: WorkflowJson, diagnostics: Diagnostic[]): void {
	const required: Array<{ key: keyof WorkflowJson; label: string }> = [
		{ key: "name", label: "name" },
		{ key: "version", label: "version" },
		{ key: "trigger", label: "trigger" },
		{ key: "steps", label: "steps" },
		{ key: "nodes", label: "nodes" },
	];

	for (const { key, label } of required) {
		if (workflow[key] === undefined) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: createRange(0, 0, 0, 1),
				message: `Missing required field: "${label}"`,
				source: "blok",
			});
		}
	}

	if (typeof workflow.name === "string" && workflow.name.length === 0) {
		const range = findKeyRange(text, "name");
		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			range,
			message: "Workflow name cannot be empty",
			source: "blok",
		});
	}
}

function validateVersion(text: string, workflow: WorkflowJson, diagnostics: Diagnostic[]): void {
	if (typeof workflow.version !== "string") return;

	const semverRegex = /^\d+\.\d+\.\d+$/;
	if (!semverRegex.test(workflow.version)) {
		const range = findKeyRange(text, "version");
		diagnostics.push({
			severity: DiagnosticSeverity.Warning,
			range,
			message: `Invalid version format "${workflow.version}". Expected semver (e.g., 1.0.0)`,
			source: "blok",
		});
	}
}

function validateTrigger(text: string, workflow: WorkflowJson, diagnostics: Diagnostic[]): void {
	if (!workflow.trigger || typeof workflow.trigger !== "object") return;

	const triggerKeys = Object.keys(workflow.trigger);

	if (triggerKeys.length === 0) {
		const range = findKeyRange(text, "trigger");
		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			range,
			message: "Trigger must have at least one type defined",
			source: "blok",
		});
		return;
	}

	if (triggerKeys.length > 1) {
		const range = findKeyRange(text, "trigger");
		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			range,
			message: `Only one trigger type allowed per workflow. Found: ${triggerKeys.join(", ")}`,
			source: "blok",
		});
	}

	const triggerType = triggerKeys[0];
	if (!VALID_TRIGGERS.includes(triggerType as (typeof VALID_TRIGGERS)[number])) {
		const range = findKeyRange(text, triggerType);
		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			range,
			message: `Unknown trigger type "${triggerType}". Valid types: ${VALID_TRIGGERS.join(", ")}`,
			source: "blok",
		});
	}

	// HTTP trigger validation
	if (triggerType === "http") {
		const httpConfig = workflow.trigger.http as Record<string, unknown> | undefined;
		if (httpConfig && typeof httpConfig === "object") {
			if (!httpConfig.method) {
				const range = findKeyRange(text, "http");
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range,
					message: 'HTTP trigger requires "method" field',
					source: "blok",
				});
			} else if (
				typeof httpConfig.method === "string" &&
				!VALID_HTTP_METHODS.includes(httpConfig.method as (typeof VALID_HTTP_METHODS)[number])
			) {
				const range = findValueRange(text, "method", httpConfig.method as string);
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range,
					message: `Invalid HTTP method "${httpConfig.method}". Valid: ${VALID_HTTP_METHODS.join(", ")}`,
					source: "blok",
				});
			}
			if (!httpConfig.path) {
				const range = findKeyRange(text, "http");
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range,
					message: 'HTTP trigger requires "path" field',
					source: "blok",
				});
			}
		}
	}

	// Cron trigger validation
	if (triggerType === "cron") {
		const cronConfig = workflow.trigger.cron as Record<string, unknown> | undefined;
		if (cronConfig && typeof cronConfig === "object") {
			if (!cronConfig.schedule) {
				const range = findKeyRange(text, "cron");
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range,
					message: 'Cron trigger requires "schedule" field',
					source: "blok",
				});
			} else if (typeof cronConfig.schedule === "string") {
				const parts = cronConfig.schedule.trim().split(/\s+/);
				if (parts.length < 5 || parts.length > 6) {
					const range = findValueRange(text, "schedule", cronConfig.schedule);
					diagnostics.push({
						severity: DiagnosticSeverity.Warning,
						range,
						message: "Invalid cron expression. Expected 5-6 fields (minute hour day month weekday [second])",
						source: "blok",
					});
				}
			}
		}
	}

	// Queue trigger validation
	if (triggerType === "queue") {
		const queueConfig = workflow.trigger.queue as Record<string, unknown> | undefined;
		if (queueConfig && typeof queueConfig === "object") {
			if (!queueConfig.provider) {
				const range = findKeyRange(text, "queue");
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range,
					message: 'Queue trigger requires "provider" field',
					source: "blok",
				});
			}
			if (!queueConfig.topic) {
				const range = findKeyRange(text, "queue");
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range,
					message: 'Queue trigger requires "topic" field',
					source: "blok",
				});
			}
		}
	}

	// Webhook trigger validation
	if (triggerType === "webhook") {
		const webhookConfig = workflow.trigger.webhook as Record<string, unknown> | undefined;
		if (webhookConfig && typeof webhookConfig === "object") {
			if (!webhookConfig.source) {
				const range = findKeyRange(text, "webhook");
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range,
					message: 'Webhook trigger requires "source" field',
					source: "blok",
				});
			}
			if (!webhookConfig.events || !Array.isArray(webhookConfig.events)) {
				const range = findKeyRange(text, "webhook");
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range,
					message: 'Webhook trigger requires "events" array',
					source: "blok",
				});
			}
		}
	}

	// Pubsub trigger validation
	if (triggerType === "pubsub") {
		const pubsubConfig = workflow.trigger.pubsub as Record<string, unknown> | undefined;
		if (pubsubConfig && typeof pubsubConfig === "object") {
			if (!pubsubConfig.provider) {
				const range = findKeyRange(text, "pubsub");
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range,
					message: 'Pub/Sub trigger requires "provider" field',
					source: "blok",
				});
			}
			if (!pubsubConfig.topic && !pubsubConfig.channel) {
				const range = findKeyRange(text, "pubsub");
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range,
					message: 'Pub/Sub trigger requires "topic" or "channel" field',
					source: "blok",
				});
			}
		}
	}

	// Worker trigger validation
	if (triggerType === "worker") {
		const workerConfig = workflow.trigger.worker as Record<string, unknown> | undefined;
		if (workerConfig && typeof workerConfig === "object") {
			if (!workerConfig.queue) {
				const range = findKeyRange(text, "worker");
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range,
					message: 'Worker trigger requires "queue" field',
					source: "blok",
				});
			}
		}
	}
}

function validateSteps(text: string, workflow: WorkflowJson, diagnostics: Diagnostic[]): void {
	if (!Array.isArray(workflow.steps)) return;

	const stepNames = new Set<string>();

	for (let i = 0; i < workflow.steps.length; i++) {
		const step = workflow.steps[i] as Record<string, unknown>;
		if (!step || typeof step !== "object") {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: findArrayItemRange(text, "steps", i),
				message: `Step ${i} must be an object`,
				source: "blok",
			});
			continue;
		}

		if (!step.name || typeof step.name !== "string") {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: findArrayItemRange(text, "steps", i),
				message: `Step ${i} is missing required "name" field`,
				source: "blok",
			});
		} else {
			if (stepNames.has(step.name)) {
				diagnostics.push({
					severity: DiagnosticSeverity.Warning,
					range: findValueRange(text, "name", step.name),
					message: `Duplicate step name "${step.name}"`,
					source: "blok",
				});
			}
			stepNames.add(step.name);
		}

		if (!step.node || typeof step.node !== "string") {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: findArrayItemRange(text, "steps", i),
				message: `Step "${step.name || i}" is missing required "node" field`,
				source: "blok",
			});
		}

		if (!step.type || typeof step.type !== "string") {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: findArrayItemRange(text, "steps", i),
				message: `Step "${step.name || i}" is missing required "type" field`,
				source: "blok",
			});
		} else if (!VALID_STEP_TYPES.includes(step.type as (typeof VALID_STEP_TYPES)[number])) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: findValueRange(text, "type", step.type),
				message: `Invalid step type "${step.type}". Valid: ${VALID_STEP_TYPES.join(", ")}`,
				source: "blok",
			});
		}

		if (
			step.runtime &&
			typeof step.runtime === "string" &&
			!VALID_RUNTIMES.includes(step.runtime as (typeof VALID_RUNTIMES)[number])
		) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: findValueRange(text, "runtime", step.runtime),
				message: `Invalid runtime "${step.runtime}". Valid: ${VALID_RUNTIMES.join(", ")}`,
				source: "blok",
			});
		}
	}
}

function validateNodeReferences(text: string, workflow: WorkflowJson, diagnostics: Diagnostic[]): void {
	if (!Array.isArray(workflow.steps) || typeof workflow.nodes !== "object" || !workflow.nodes) return;

	const referencedNodes = collectStepNames(workflow.steps);
	const definedNodes = new Set(Object.keys(workflow.nodes));

	// Check for steps referencing undefined nodes
	for (const stepName of referencedNodes) {
		if (!definedNodes.has(stepName)) {
			const range = findValueRange(text, "name", stepName);
			diagnostics.push({
				severity: DiagnosticSeverity.Warning,
				range,
				message: `Step "${stepName}" references a node that is not defined in "nodes"`,
				source: "blok",
			});
		}
	}

	// Check for nodes with conditions and collect nested step names
	const allReferenced = new Set(referencedNodes);
	for (const [, nodeConfig] of Object.entries(workflow.nodes)) {
		if (nodeConfig && typeof nodeConfig === "object") {
			const cfg = nodeConfig as Record<string, unknown>;
			if (Array.isArray(cfg.conditions)) {
				for (const cond of cfg.conditions) {
					if (cond && typeof cond === "object" && Array.isArray((cond as Record<string, unknown>).steps)) {
						const nestedNames = collectStepNames((cond as Record<string, unknown>).steps as unknown[]);
						for (const n of nestedNames) allReferenced.add(n);
					}
				}
			}
		}
	}

	// Check for unused nodes
	for (const nodeName of definedNodes) {
		if (!allReferenced.has(nodeName)) {
			const range = findKeyRange(text, nodeName);
			diagnostics.push({
				severity: DiagnosticSeverity.Information,
				range,
				message: `Node "${nodeName}" is defined but not referenced by any step`,
				source: "blok",
			});
		}
	}
}

function collectStepNames(steps: unknown[]): Set<string> {
	const names = new Set<string>();
	for (const step of steps) {
		if (step && typeof step === "object") {
			const s = step as Record<string, unknown>;
			if (typeof s.name === "string") {
				names.add(s.name);
			}
		}
	}
	return names;
}

// --- Range helpers ---

function createRange(startLine: number, startChar: number, endLine: number, endChar: number): Range {
	return Range.create(Position.create(startLine, startChar), Position.create(endLine, endChar));
}

export function findKeyRange(text: string, key: string): Range {
	const pattern = new RegExp(`"${escapeRegex(key)}"\\s*:`);
	const match = pattern.exec(text);
	if (match) {
		const pos = offsetToPosition(text, match.index);
		return createRange(pos.line, pos.character, pos.line, pos.character + match[0].length);
	}
	return createRange(0, 0, 0, 1);
}

export function findValueRange(text: string, key: string, value: string): Range {
	const pattern = new RegExp(`"${escapeRegex(key)}"\\s*:\\s*"${escapeRegex(value)}"`);
	const match = pattern.exec(text);
	if (match) {
		const pos = offsetToPosition(text, match.index);
		return createRange(pos.line, pos.character, pos.line, pos.character + match[0].length);
	}
	return findKeyRange(text, key);
}

function findArrayItemRange(text: string, arrayKey: string, index: number): Range {
	const keyMatch = new RegExp(`"${escapeRegex(arrayKey)}"\\s*:\\s*\\[`).exec(text);
	if (!keyMatch) return createRange(0, 0, 0, 1);

	let depth = 0;
	let itemCount = 0;
	const start = keyMatch.index + keyMatch[0].length;

	for (let i = start; i < text.length; i++) {
		if (text[i] === "{" || text[i] === "[") {
			if (depth === 0 && itemCount === index) {
				const pos = offsetToPosition(text, i);
				return createRange(pos.line, pos.character, pos.line, pos.character + 1);
			}
			depth++;
		} else if (text[i] === "}" || text[i] === "]") {
			depth--;
			if (depth === 0) itemCount++;
		}
	}

	return createRange(0, 0, 0, 1);
}

export function offsetToPosition(text: string, offset: number): Position {
	let line = 0;
	let col = 0;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text[i] === "\n") {
			line++;
			col = 0;
		} else {
			col++;
		}
	}
	return Position.create(line, col);
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
