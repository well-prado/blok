import * as vscode from "vscode";

interface WorkflowJson {
	name?: unknown;
	version?: unknown;
	description?: unknown;
	trigger?: Record<string, unknown>;
	steps?: unknown[];
	nodes?: Record<string, unknown>;
}

const VALID_TRIGGERS = ["http", "grpc", "manual", "cron", "queue", "pubsub", "worker", "webhook", "websocket", "sse"];

const VALID_HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "ANY"];

const VALID_STEP_TYPES = [
	"local",
	"module",
	"runtime.nodejs",
	"runtime.python3",
	"runtime.go",
	"runtime.java",
	"runtime.rust",
	"runtime.php",
	"runtime.csharp",
	"runtime.ruby",
];

const VALID_RUNTIMES = ["nodejs", "bun", "python3", "go", "java", "rust", "php", "csharp", "ruby", "docker", "wasm"];

/**
 * Provides rich diagnostic validation for Blok workflow JSON files.
 *
 * Validates:
 * - Required fields (name, version, trigger, steps, nodes)
 * - Version format (semver)
 * - Trigger configuration (type-specific validation)
 * - Step structure (name, node, type)
 * - Node configuration references (steps must reference defined nodes)
 * - Unused nodes (nodes defined but not referenced by any step)
 * - Runtime field validation
 * - Condition structure
 */
export class WorkflowDiagnostics {
	constructor(private diagnosticCollection: vscode.DiagnosticCollection) {}

	validate(document: vscode.TextDocument): void {
		const diagnostics: vscode.Diagnostic[] = [];
		const text = document.getText();

		let workflow: WorkflowJson;
		try {
			workflow = JSON.parse(text);
		} catch {
			diagnostics.push(
				new vscode.Diagnostic(
					new vscode.Range(0, 0, 0, 1),
					"Invalid JSON: failed to parse workflow file",
					vscode.DiagnosticSeverity.Error,
				),
			);
			this.diagnosticCollection.set(document.uri, diagnostics);
			return;
		}

		if (typeof workflow !== "object" || workflow === null || Array.isArray(workflow)) {
			diagnostics.push(
				new vscode.Diagnostic(
					new vscode.Range(0, 0, 0, 1),
					"Workflow must be a JSON object",
					vscode.DiagnosticSeverity.Error,
				),
			);
			this.diagnosticCollection.set(document.uri, diagnostics);
			return;
		}

		this.validateRequiredFields(text, workflow, diagnostics);
		this.validateVersion(text, workflow, diagnostics);
		this.validateTrigger(text, workflow, diagnostics);
		this.validateSteps(text, workflow, diagnostics);
		this.validateNodeReferences(text, workflow, diagnostics);

		this.diagnosticCollection.set(document.uri, diagnostics);
	}

	private validateRequiredFields(text: string, workflow: WorkflowJson, diagnostics: vscode.Diagnostic[]): void {
		const required: Array<{ key: keyof WorkflowJson; label: string }> = [
			{ key: "name", label: "name" },
			{ key: "version", label: "version" },
			{ key: "trigger", label: "trigger" },
			{ key: "steps", label: "steps" },
			{ key: "nodes", label: "nodes" },
		];

		for (const { key, label } of required) {
			if (workflow[key] === undefined) {
				diagnostics.push(
					new vscode.Diagnostic(
						new vscode.Range(0, 0, 0, 1),
						`Missing required field: "${label}"`,
						vscode.DiagnosticSeverity.Error,
					),
				);
			}
		}

		if (typeof workflow.name === "string" && workflow.name.length === 0) {
			const range = this.findKeyRange(text, "name");
			diagnostics.push(new vscode.Diagnostic(range, "Workflow name cannot be empty", vscode.DiagnosticSeverity.Error));
		}
	}

	private validateVersion(text: string, workflow: WorkflowJson, diagnostics: vscode.Diagnostic[]): void {
		if (typeof workflow.version !== "string") return;

		const semverRegex = /^\d+\.\d+\.\d+$/;
		if (!semverRegex.test(workflow.version)) {
			const range = this.findKeyRange(text, "version");
			diagnostics.push(
				new vscode.Diagnostic(
					range,
					`Invalid version format "${workflow.version}". Expected semver (e.g., 1.0.0)`,
					vscode.DiagnosticSeverity.Warning,
				),
			);
		}
	}

	private validateTrigger(text: string, workflow: WorkflowJson, diagnostics: vscode.Diagnostic[]): void {
		if (!workflow.trigger || typeof workflow.trigger !== "object") return;

		const triggerKeys = Object.keys(workflow.trigger);

		if (triggerKeys.length === 0) {
			const range = this.findKeyRange(text, "trigger");
			diagnostics.push(
				new vscode.Diagnostic(range, "Trigger must have at least one type defined", vscode.DiagnosticSeverity.Error),
			);
			return;
		}

		if (triggerKeys.length > 1) {
			const range = this.findKeyRange(text, "trigger");
			diagnostics.push(
				new vscode.Diagnostic(
					range,
					`Only one trigger type allowed per workflow. Found: ${triggerKeys.join(", ")}`,
					vscode.DiagnosticSeverity.Error,
				),
			);
		}

		const triggerType = triggerKeys[0];
		if (!VALID_TRIGGERS.includes(triggerType)) {
			const range = this.findKeyRange(text, triggerType);
			diagnostics.push(
				new vscode.Diagnostic(
					range,
					`Unknown trigger type "${triggerType}". Valid types: ${VALID_TRIGGERS.join(", ")}`,
					vscode.DiagnosticSeverity.Error,
				),
			);
		}

		// HTTP trigger validation
		if (triggerType === "http") {
			const httpConfig = workflow.trigger.http as Record<string, unknown> | undefined;
			if (httpConfig && typeof httpConfig === "object") {
				if (!httpConfig.method) {
					const range = this.findKeyRange(text, "http");
					diagnostics.push(
						new vscode.Diagnostic(range, 'HTTP trigger requires "method" field', vscode.DiagnosticSeverity.Error),
					);
				} else if (typeof httpConfig.method === "string" && !VALID_HTTP_METHODS.includes(httpConfig.method)) {
					const range = this.findValueRange(text, "method", httpConfig.method as string);
					diagnostics.push(
						new vscode.Diagnostic(
							range,
							`Invalid HTTP method "${httpConfig.method}". Valid: ${VALID_HTTP_METHODS.join(", ")}`,
							vscode.DiagnosticSeverity.Error,
						),
					);
				}
				if (!httpConfig.path) {
					const range = this.findKeyRange(text, "http");
					diagnostics.push(
						new vscode.Diagnostic(range, 'HTTP trigger requires "path" field', vscode.DiagnosticSeverity.Error),
					);
				}
			}
		}

		// Cron trigger validation
		if (triggerType === "cron") {
			const cronConfig = workflow.trigger.cron as Record<string, unknown> | undefined;
			if (cronConfig && typeof cronConfig === "object") {
				if (!cronConfig.schedule) {
					const range = this.findKeyRange(text, "cron");
					diagnostics.push(
						new vscode.Diagnostic(range, 'Cron trigger requires "schedule" field', vscode.DiagnosticSeverity.Error),
					);
				} else if (typeof cronConfig.schedule === "string") {
					const parts = cronConfig.schedule.trim().split(/\s+/);
					if (parts.length < 5 || parts.length > 6) {
						const range = this.findValueRange(text, "schedule", cronConfig.schedule as string);
						diagnostics.push(
							new vscode.Diagnostic(
								range,
								"Invalid cron expression. Expected 5-6 fields (minute hour day month weekday [second])",
								vscode.DiagnosticSeverity.Warning,
							),
						);
					}
				}
			}
		}

		// Queue trigger validation
		if (triggerType === "queue") {
			const queueConfig = workflow.trigger.queue as Record<string, unknown> | undefined;
			if (queueConfig && typeof queueConfig === "object") {
				if (!queueConfig.provider) {
					const range = this.findKeyRange(text, "queue");
					diagnostics.push(
						new vscode.Diagnostic(range, 'Queue trigger requires "provider" field', vscode.DiagnosticSeverity.Error),
					);
				}
				if (!queueConfig.topic) {
					const range = this.findKeyRange(text, "queue");
					diagnostics.push(
						new vscode.Diagnostic(range, 'Queue trigger requires "topic" field', vscode.DiagnosticSeverity.Error),
					);
				}
			}
		}

		// Webhook trigger validation
		if (triggerType === "webhook") {
			const webhookConfig = workflow.trigger.webhook as Record<string, unknown> | undefined;
			if (webhookConfig && typeof webhookConfig === "object") {
				if (!webhookConfig.source) {
					const range = this.findKeyRange(text, "webhook");
					diagnostics.push(
						new vscode.Diagnostic(range, 'Webhook trigger requires "source" field', vscode.DiagnosticSeverity.Error),
					);
				}
				if (!webhookConfig.events || !Array.isArray(webhookConfig.events)) {
					const range = this.findKeyRange(text, "webhook");
					diagnostics.push(
						new vscode.Diagnostic(range, 'Webhook trigger requires "events" array', vscode.DiagnosticSeverity.Error),
					);
				}
			}
		}
	}

	private validateSteps(text: string, workflow: WorkflowJson, diagnostics: vscode.Diagnostic[]): void {
		if (!Array.isArray(workflow.steps)) return;

		const stepNames = new Set<string>();

		for (let i = 0; i < workflow.steps.length; i++) {
			const step = workflow.steps[i] as Record<string, unknown>;
			if (!step || typeof step !== "object") {
				diagnostics.push(
					new vscode.Diagnostic(
						this.findArrayItemRange(text, "steps", i),
						`Step ${i} must be an object`,
						vscode.DiagnosticSeverity.Error,
					),
				);
				continue;
			}

			if (!step.name || typeof step.name !== "string") {
				diagnostics.push(
					new vscode.Diagnostic(
						this.findArrayItemRange(text, "steps", i),
						`Step ${i} is missing required "name" field`,
						vscode.DiagnosticSeverity.Error,
					),
				);
			} else {
				if (stepNames.has(step.name)) {
					diagnostics.push(
						new vscode.Diagnostic(
							this.findValueRange(text, "name", step.name),
							`Duplicate step name "${step.name}"`,
							vscode.DiagnosticSeverity.Warning,
						),
					);
				}
				stepNames.add(step.name);
			}

			if (!step.node || typeof step.node !== "string") {
				diagnostics.push(
					new vscode.Diagnostic(
						this.findArrayItemRange(text, "steps", i),
						`Step "${step.name || i}" is missing required "node" field`,
						vscode.DiagnosticSeverity.Error,
					),
				);
			}

			if (!step.type || typeof step.type !== "string") {
				diagnostics.push(
					new vscode.Diagnostic(
						this.findArrayItemRange(text, "steps", i),
						`Step "${step.name || i}" is missing required "type" field`,
						vscode.DiagnosticSeverity.Error,
					),
				);
			} else if (!VALID_STEP_TYPES.includes(step.type)) {
				diagnostics.push(
					new vscode.Diagnostic(
						this.findValueRange(text, "type", step.type),
						`Invalid step type "${step.type}". Valid: ${VALID_STEP_TYPES.join(", ")}`,
						vscode.DiagnosticSeverity.Error,
					),
				);
			}

			if (step.runtime && typeof step.runtime === "string" && !VALID_RUNTIMES.includes(step.runtime)) {
				diagnostics.push(
					new vscode.Diagnostic(
						this.findValueRange(text, "runtime", step.runtime),
						`Invalid runtime "${step.runtime}". Valid: ${VALID_RUNTIMES.join(", ")}`,
						vscode.DiagnosticSeverity.Error,
					),
				);
			}
		}
	}

	private validateNodeReferences(text: string, workflow: WorkflowJson, diagnostics: vscode.Diagnostic[]): void {
		if (!Array.isArray(workflow.steps) || typeof workflow.nodes !== "object" || !workflow.nodes) return;

		const referencedNodes = this.collectStepNames(workflow.steps);
		const definedNodes = new Set(Object.keys(workflow.nodes));

		// Check for steps referencing undefined nodes
		for (const stepName of referencedNodes) {
			if (!definedNodes.has(stepName)) {
				const range = this.findValueRange(text, "name", stepName);
				diagnostics.push(
					new vscode.Diagnostic(
						range,
						`Step "${stepName}" references a node that is not defined in "nodes"`,
						vscode.DiagnosticSeverity.Warning,
					),
				);
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
							const nestedNames = this.collectStepNames((cond as Record<string, unknown>).steps as unknown[]);
							for (const n of nestedNames) allReferenced.add(n);
						}
					}
				}
			}
		}

		// Check for unused nodes (info level)
		for (const nodeName of definedNodes) {
			if (!allReferenced.has(nodeName)) {
				const range = this.findKeyRange(text, nodeName);
				diagnostics.push(
					new vscode.Diagnostic(
						range,
						`Node "${nodeName}" is defined but not referenced by any step`,
						vscode.DiagnosticSeverity.Information,
					),
				);
			}
		}
	}

	private collectStepNames(steps: unknown[]): Set<string> {
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

	private findKeyRange(text: string, key: string): vscode.Range {
		const pattern = new RegExp(`"${this.escapeRegex(key)}"\\s*:`);
		const match = pattern.exec(text);
		if (match) {
			const pos = this.offsetToPosition(text, match.index);
			return new vscode.Range(pos, new vscode.Position(pos.line, pos.character + match[0].length));
		}
		return new vscode.Range(0, 0, 0, 1);
	}

	private findValueRange(text: string, key: string, value: string): vscode.Range {
		const pattern = new RegExp(`"${this.escapeRegex(key)}"\\s*:\\s*"${this.escapeRegex(value)}"`);
		const match = pattern.exec(text);
		if (match) {
			const pos = this.offsetToPosition(text, match.index);
			return new vscode.Range(pos, new vscode.Position(pos.line, pos.character + match[0].length));
		}
		return this.findKeyRange(text, key);
	}

	private findArrayItemRange(text: string, arrayKey: string, index: number): vscode.Range {
		const keyMatch = new RegExp(`"${this.escapeRegex(arrayKey)}"\\s*:\\s*\\[`).exec(text);
		if (!keyMatch) return new vscode.Range(0, 0, 0, 1);

		let depth = 0;
		let itemCount = 0;
		const start = keyMatch.index + keyMatch[0].length;

		for (let i = start; i < text.length; i++) {
			if (text[i] === "{" || text[i] === "[") {
				if (depth === 0 && itemCount === index) {
					const pos = this.offsetToPosition(text, i);
					return new vscode.Range(pos.line, pos.character, pos.line, pos.character + 1);
				}
				depth++;
			} else if (text[i] === "}" || text[i] === "]") {
				depth--;
				if (depth === 0) itemCount++;
			}
		}

		return new vscode.Range(0, 0, 0, 1);
	}

	private offsetToPosition(text: string, offset: number): vscode.Position {
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
		return new vscode.Position(line, col);
	}

	private escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
}
