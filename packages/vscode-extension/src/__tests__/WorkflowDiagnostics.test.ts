import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock vscode module before importing the diagnostics provider
vi.mock("vscode", () => import("./vscode-mock"));

import * as vscode from "vscode";
import { WorkflowDiagnostics } from "../providers/WorkflowDiagnostics";

function createMockDocument(content: string): vscode.TextDocument {
	return {
		getText: () => content,
		uri: { fsPath: "/test/workflow.json" } as vscode.Uri,
		languageId: "json",
	} as unknown as vscode.TextDocument;
}

describe("WorkflowDiagnostics", () => {
	let diagnosticCollection: ReturnType<typeof vscode.languages.createDiagnosticCollection>;
	let diagnostics: WorkflowDiagnostics;

	beforeEach(() => {
		diagnosticCollection = vscode.languages.createDiagnosticCollection("blok-test");
		diagnostics = new WorkflowDiagnostics(diagnosticCollection as unknown as vscode.DiagnosticCollection);
	});

	describe("JSON parsing", () => {
		it("should report error for invalid JSON", () => {
			const doc = createMockDocument("{ invalid json }");
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			expect(diags.length).toBeGreaterThan(0);
			expect(diags[0].message).toContain("Invalid JSON");
		});

		it("should report error for non-object JSON", () => {
			const doc = createMockDocument('"just a string"');
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			expect(diags.length).toBeGreaterThan(0);
			expect(diags[0].message).toContain("must be a JSON object");
		});

		it("should report error for array JSON", () => {
			const doc = createMockDocument("[1, 2, 3]");
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			expect(diags[0].message).toContain("must be a JSON object");
		});
	});

	describe("required fields", () => {
		it("should report missing required fields", () => {
			const doc = createMockDocument("{}");
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const messages = diags.map((d) => d.message);

			expect(messages).toContain('Missing required field: "name"');
			expect(messages).toContain('Missing required field: "version"');
			expect(messages).toContain('Missing required field: "trigger"');
			expect(messages).toContain('Missing required field: "steps"');
			expect(messages).toContain('Missing required field: "nodes"');
		});

		it("should report empty name", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "",
					version: "1.0.0",
					trigger: { http: { method: "GET", path: "/" } },
					steps: [{ name: "s1", node: "n1", type: "local" }],
					nodes: { s1: { inputs: {} } },
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const messages = diags.map((d) => d.message);
			expect(messages).toContain("Workflow name cannot be empty");
		});

		it("should not report errors for valid workflow", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test-workflow",
					version: "1.0.0",
					trigger: { http: { method: "GET", path: "/" } },
					steps: [{ name: "step1", node: "@nanoservice-ts/api-call", type: "module" }],
					nodes: { step1: { inputs: { url: "https://example.com" } } },
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			expect(diags.length).toBe(0);
		});
	});

	describe("version validation", () => {
		it("should warn on invalid semver", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test",
					version: "v1.0",
					trigger: { http: { method: "GET", path: "/" } },
					steps: [{ name: "s1", node: "n1", type: "local" }],
					nodes: { s1: {} },
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const versionDiags = diags.filter((d) => d.message.includes("version format"));
			expect(versionDiags.length).toBe(1);
		});

		it("should accept valid semver", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test",
					version: "2.3.1",
					trigger: { http: { method: "GET", path: "/" } },
					steps: [{ name: "s1", node: "n1", type: "local" }],
					nodes: { s1: {} },
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const versionDiags = diags.filter((d) => d.message.includes("version"));
			expect(versionDiags.length).toBe(0);
		});
	});

	describe("trigger validation", () => {
		it("should report unknown trigger type", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { unknown_trigger: {} },
					steps: [{ name: "s1", node: "n1", type: "local" }],
					nodes: { s1: {} },
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const triggerDiags = diags.filter((d) => d.message.includes("Unknown trigger type"));
			expect(triggerDiags.length).toBe(1);
		});

		it("should report multiple triggers", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { http: { method: "GET", path: "/" }, cron: { schedule: "* * * * *" } },
					steps: [{ name: "s1", node: "n1", type: "local" }],
					nodes: { s1: {} },
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const triggerDiags = diags.filter((d) => d.message.includes("Only one trigger type"));
			expect(triggerDiags.length).toBe(1);
		});

		it("should report empty trigger object", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: {},
					steps: [{ name: "s1", node: "n1", type: "local" }],
					nodes: { s1: {} },
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const triggerDiags = diags.filter((d) => d.message.includes("at least one type"));
			expect(triggerDiags.length).toBe(1);
		});

		it("should validate HTTP trigger requires method", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { http: { path: "/" } },
					steps: [{ name: "s1", node: "n1", type: "local" }],
					nodes: { s1: {} },
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const methodDiags = diags.filter((d) => d.message.includes("method"));
			expect(methodDiags.length).toBeGreaterThan(0);
		});

		it("should validate HTTP trigger requires path", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { http: { method: "GET" } },
					steps: [{ name: "s1", node: "n1", type: "local" }],
					nodes: { s1: {} },
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const pathDiags = diags.filter((d) => d.message.includes("path"));
			expect(pathDiags.length).toBeGreaterThan(0);
		});

		it("should validate HTTP method values", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { http: { method: "INVALID", path: "/" } },
					steps: [{ name: "s1", node: "n1", type: "local" }],
					nodes: { s1: {} },
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const methodDiags = diags.filter((d) => d.message.includes("Invalid HTTP method"));
			expect(methodDiags.length).toBe(1);
		});

		it("should validate cron trigger requires schedule", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { cron: {} },
					steps: [{ name: "s1", node: "n1", type: "local" }],
					nodes: { s1: {} },
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const cronDiags = diags.filter((d) => d.message.includes("schedule"));
			expect(cronDiags.length).toBeGreaterThan(0);
		});

		it("should validate cron expression format", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { cron: { schedule: "invalid cron" } },
					steps: [{ name: "s1", node: "n1", type: "local" }],
					nodes: { s1: {} },
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const cronDiags = diags.filter((d) => d.message.includes("Invalid cron"));
			expect(cronDiags.length).toBe(1);
		});

		it("should accept valid cron expression", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { cron: { schedule: "*/5 * * * *" } },
					steps: [{ name: "s1", node: "n1", type: "local" }],
					nodes: { s1: {} },
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const cronDiags = diags.filter((d) => d.message.includes("cron"));
			expect(cronDiags.length).toBe(0);
		});

		it("should accept all valid trigger types", () => {
			const validTriggers = [
				"http",
				"grpc",
				"manual",
				"cron",
				"queue",
				"pubsub",
				"worker",
				"webhook",
				"websocket",
				"sse",
			];
			for (const triggerType of validTriggers) {
				const triggerConfig: Record<string, unknown> = {};
				if (triggerType === "http") triggerConfig[triggerType] = { method: "GET", path: "/" };
				else if (triggerType === "cron") triggerConfig[triggerType] = { schedule: "* * * * *" };
				else if (triggerType === "queue") triggerConfig[triggerType] = { provider: "kafka", topic: "test" };
				else if (triggerType === "webhook") triggerConfig[triggerType] = { source: "github", events: ["push"] };
				else triggerConfig[triggerType] = {};

				const doc = createMockDocument(
					JSON.stringify({
						name: "test",
						version: "1.0.0",
						trigger: triggerConfig,
						steps: [{ name: "s1", node: "n1", type: "local" }],
						nodes: { s1: {} },
					}),
				);
				diagnostics.validate(doc);

				const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
				const diags = entries.get("/test/workflow.json") || [];
				const unknownTrigger = diags.filter((d) => d.message.includes("Unknown trigger"));
				expect(unknownTrigger.length).toBe(0);
			}
		});

		it("should validate queue trigger requires provider and topic", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { queue: {} },
					steps: [{ name: "s1", node: "n1", type: "local" }],
					nodes: { s1: {} },
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const queueDiags = diags.filter((d) => d.message.includes("Queue trigger"));
			expect(queueDiags.length).toBe(2); // provider + topic
		});

		it("should validate webhook trigger requires source and events", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { webhook: {} },
					steps: [{ name: "s1", node: "n1", type: "local" }],
					nodes: { s1: {} },
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const webhookDiags = diags.filter((d) => d.message.includes("Webhook trigger"));
			expect(webhookDiags.length).toBe(2); // source + events
		});
	});

	describe("step validation", () => {
		it("should report missing step name", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { manual: {} },
					steps: [{ node: "n1", type: "local" }],
					nodes: {},
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const stepDiags = diags.filter((d) => d.message.includes("name"));
			expect(stepDiags.length).toBeGreaterThan(0);
		});

		it("should report missing step node", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { manual: {} },
					steps: [{ name: "s1", type: "local" }],
					nodes: {},
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const stepDiags = diags.filter((d) => d.message.includes("node"));
			expect(stepDiags.length).toBeGreaterThan(0);
		});

		it("should report invalid step type", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { manual: {} },
					steps: [{ name: "s1", node: "n1", type: "invalid_type" }],
					nodes: { s1: {} },
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const typeDiags = diags.filter((d) => d.message.includes("Invalid step type"));
			expect(typeDiags.length).toBe(1);
		});

		it("should accept all valid step types", () => {
			const validTypes = [
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
			for (const stepType of validTypes) {
				const doc = createMockDocument(
					JSON.stringify({
						name: "test",
						version: "1.0.0",
						trigger: { manual: {} },
						steps: [{ name: "s1", node: "n1", type: stepType }],
						nodes: { s1: {} },
					}),
				);
				diagnostics.validate(doc);

				const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
				const diags = entries.get("/test/workflow.json") || [];
				const typeDiags = diags.filter((d) => d.message.includes("Invalid step type"));
				expect(typeDiags.length).toBe(0);
			}
		});

		it("should report invalid runtime value", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { manual: {} },
					steps: [{ name: "s1", node: "n1", type: "local", runtime: "brainfuck" }],
					nodes: { s1: {} },
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const runtimeDiags = diags.filter((d) => d.message.includes("Invalid runtime"));
			expect(runtimeDiags.length).toBe(1);
		});

		it("should accept valid runtimes", () => {
			const validRuntimes = [
				"nodejs",
				"bun",
				"python3",
				"go",
				"java",
				"rust",
				"php",
				"csharp",
				"ruby",
				"docker",
				"wasm",
			];
			for (const runtime of validRuntimes) {
				const doc = createMockDocument(
					JSON.stringify({
						name: "test",
						version: "1.0.0",
						trigger: { manual: {} },
						steps: [{ name: "s1", node: "n1", type: "local", runtime }],
						nodes: { s1: {} },
					}),
				);
				diagnostics.validate(doc);

				const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
				const diags = entries.get("/test/workflow.json") || [];
				const runtimeDiags = diags.filter((d) => d.message.includes("Invalid runtime"));
				expect(runtimeDiags.length).toBe(0);
			}
		});

		it("should report duplicate step names", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { manual: {} },
					steps: [
						{ name: "step1", node: "n1", type: "local" },
						{ name: "step1", node: "n2", type: "local" },
					],
					nodes: { step1: {} },
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const dupDiags = diags.filter((d) => d.message.includes("Duplicate step name"));
			expect(dupDiags.length).toBe(1);
		});
	});

	describe("node reference validation", () => {
		it("should warn about unreferenced steps in nodes", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { manual: {} },
					steps: [{ name: "s1", node: "n1", type: "local" }],
					nodes: {
						s1: { inputs: {} },
						unused_node: { inputs: {} },
					},
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const unusedDiags = diags.filter((d) => d.message.includes("not referenced"));
			expect(unusedDiags.length).toBe(1);
			expect(unusedDiags[0].message).toContain("unused_node");
		});

		it("should warn about steps referencing undefined nodes", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { manual: {} },
					steps: [
						{ name: "step1", node: "n1", type: "local" },
						{ name: "missing_step", node: "n2", type: "local" },
					],
					nodes: { step1: { inputs: {} } },
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const missingDiags = diags.filter((d) => d.message.includes("not defined in"));
			expect(missingDiags.length).toBe(1);
			expect(missingDiags[0].message).toContain("missing_step");
		});

		it("should not warn about nodes referenced in conditions", () => {
			const doc = createMockDocument(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { manual: {} },
					steps: [{ name: "filter", node: "@nanoservice-ts/if-else", type: "module" }],
					nodes: {
						filter: {
							conditions: [
								{
									type: "if",
									condition: "ctx.request.query.x === '1'",
									steps: [{ name: "branch-a", node: "n1", type: "local" }],
								},
							],
						},
						"branch-a": { inputs: {} },
					},
				}),
			);
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			const unusedDiags = diags.filter((d) => d.message.includes("branch-a") && d.message.includes("not referenced"));
			expect(unusedDiags.length).toBe(0);
		});
	});

	describe("complex workflow validation", () => {
		it("should validate a complete real-world workflow", () => {
			const workflow = {
				name: "User Registration",
				description: "Handles user registration with email verification",
				version: "1.0.0",
				trigger: {
					http: {
						method: "POST",
						path: "/api/register",
						accept: "application/json",
					},
				},
				steps: [{ name: "validate-input", node: "@nanoservice-ts/if-else", type: "module" }],
				nodes: {
					"validate-input": {
						conditions: [
							{
								type: "if",
								condition: "ctx.request.body.email && ctx.request.body.password",
								steps: [
									{ name: "create-user", node: "./nodes/create-user", type: "local" },
									{ name: "send-email", node: "./nodes/send-email", type: "local" },
								],
							},
							{
								type: "else",
								steps: [{ name: "error-response", node: "./nodes/error", type: "local" }],
							},
						],
					},
					"create-user": { inputs: { email: "${ctx.request.body.email}" } },
					"send-email": { inputs: { to: "${ctx.vars['create-user'].email}" } },
					"error-response": { inputs: { message: "Missing required fields" } },
				},
			};

			const doc = createMockDocument(JSON.stringify(workflow));
			diagnostics.validate(doc);

			const entries = (diagnosticCollection as unknown as { entries: Map<string, vscode.Diagnostic[]> }).entries;
			const diags = entries.get("/test/workflow.json") || [];
			// Should have zero errors for a valid workflow
			const errors = diags.filter((d) => d.severity === 0);
			expect(errors.length).toBe(0);
		});
	});
});
