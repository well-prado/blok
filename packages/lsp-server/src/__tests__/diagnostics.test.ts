import { describe, expect, it } from "vitest";
import { DiagnosticSeverity } from "vscode-languageserver";
import { validateWorkflow } from "../diagnostics";

describe("WorkflowDiagnostics (LSP)", () => {
	describe("JSON parsing", () => {
		it("should report invalid JSON", () => {
			const diagnostics = validateWorkflow("{ invalid json");
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].message).toContain("Invalid JSON");
			expect(diagnostics[0].severity).toBe(DiagnosticSeverity.Error);
		});

		it("should report non-object JSON", () => {
			const diagnostics = validateWorkflow('"hello"');
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].message).toContain("must be a JSON object");
		});

		it("should report array instead of object", () => {
			const diagnostics = validateWorkflow("[1, 2, 3]");
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].message).toContain("must be a JSON object");
		});
	});

	describe("required fields", () => {
		it("should report all missing required fields", () => {
			const diagnostics = validateWorkflow("{}");
			const messages = diagnostics.map((d) => d.message);
			expect(messages).toContain('Missing required field: "name"');
			expect(messages).toContain('Missing required field: "version"');
			expect(messages).toContain('Missing required field: "trigger"');
			expect(messages).toContain('Missing required field: "steps"');
			expect(messages).toContain('Missing required field: "nodes"');
		});

		it("should report empty name", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "",
					version: "1.0.0",
					trigger: { http: { method: "GET", path: "/" } },
					steps: [],
					nodes: {},
				}),
			);
			const emptyName = diagnostics.find((d) => d.message.includes("cannot be empty"));
			expect(emptyName).toBeDefined();
		});

		it("should pass with all required fields present", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test-workflow",
					version: "1.0.0",
					trigger: { http: { method: "GET", path: "/" } },
					steps: [],
					nodes: {},
				}),
			);
			expect(diagnostics).toHaveLength(0);
		});
	});

	describe("version validation", () => {
		it("should warn on invalid semver", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0",
					trigger: { http: { method: "GET", path: "/" } },
					steps: [],
					nodes: {},
				}),
			);
			const versionDiag = diagnostics.find((d) => d.message.includes("Invalid version"));
			expect(versionDiag).toBeDefined();
			expect(versionDiag!.severity).toBe(DiagnosticSeverity.Warning);
		});

		it("should accept valid semver", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "2.1.3",
					trigger: { http: { method: "GET", path: "/" } },
					steps: [],
					nodes: {},
				}),
			);
			expect(diagnostics).toHaveLength(0);
		});
	});

	describe("trigger validation", () => {
		it("should report empty trigger", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: {},
					steps: [],
					nodes: {},
				}),
			);
			const triggerDiag = diagnostics.find((d) => d.message.includes("at least one type"));
			expect(triggerDiag).toBeDefined();
		});

		it("should report multiple triggers", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { http: { method: "GET", path: "/" }, cron: { schedule: "* * * * *" } },
					steps: [],
					nodes: {},
				}),
			);
			const multiDiag = diagnostics.find((d) => d.message.includes("Only one trigger type"));
			expect(multiDiag).toBeDefined();
		});

		it("should report unknown trigger type", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { unknown_trigger: {} },
					steps: [],
					nodes: {},
				}),
			);
			const unknownDiag = diagnostics.find((d) => d.message.includes("Unknown trigger type"));
			expect(unknownDiag).toBeDefined();
		});

		it("should validate HTTP trigger requires method", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { http: { path: "/" } },
					steps: [],
					nodes: {},
				}),
			);
			const methodDiag = diagnostics.find((d) => d.message.includes('"method"'));
			expect(methodDiag).toBeDefined();
		});

		it("should validate HTTP trigger requires path", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { http: { method: "GET" } },
					steps: [],
					nodes: {},
				}),
			);
			const pathDiag = diagnostics.find((d) => d.message.includes('"path"'));
			expect(pathDiag).toBeDefined();
		});

		it("should validate invalid HTTP method", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { http: { method: "INVALID", path: "/" } },
					steps: [],
					nodes: {},
				}),
			);
			const invalidMethod = diagnostics.find((d) => d.message.includes("Invalid HTTP method"));
			expect(invalidMethod).toBeDefined();
		});

		it("should validate cron trigger requires schedule", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { cron: {} },
					steps: [],
					nodes: {},
				}),
			);
			const scheduleDiag = diagnostics.find((d) => d.message.includes('"schedule"'));
			expect(scheduleDiag).toBeDefined();
		});

		it("should warn on invalid cron expression", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { cron: { schedule: "invalid cron" } },
					steps: [],
					nodes: {},
				}),
			);
			const cronDiag = diagnostics.find((d) => d.message.includes("Invalid cron"));
			expect(cronDiag).toBeDefined();
			expect(cronDiag!.severity).toBe(DiagnosticSeverity.Warning);
		});

		it("should accept valid cron expression", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { cron: { schedule: "*/5 * * * *" } },
					steps: [],
					nodes: {},
				}),
			);
			expect(diagnostics).toHaveLength(0);
		});

		it("should validate queue trigger requires provider and topic", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { queue: {} },
					steps: [],
					nodes: {},
				}),
			);
			const providerDiag = diagnostics.find((d) => d.message.includes('"provider"'));
			const topicDiag = diagnostics.find((d) => d.message.includes('"topic"'));
			expect(providerDiag).toBeDefined();
			expect(topicDiag).toBeDefined();
		});

		it("should validate webhook trigger requires source and events", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { webhook: {} },
					steps: [],
					nodes: {},
				}),
			);
			const sourceDiag = diagnostics.find((d) => d.message.includes('"source"'));
			const eventsDiag = diagnostics.find((d) => d.message.includes('"events"'));
			expect(sourceDiag).toBeDefined();
			expect(eventsDiag).toBeDefined();
		});

		it("should validate pubsub trigger requires provider and topic/channel", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { pubsub: {} },
					steps: [],
					nodes: {},
				}),
			);
			const providerDiag = diagnostics.find((d) => d.message.includes('"provider"'));
			const topicDiag = diagnostics.find((d) => d.message.includes('"topic" or "channel"'));
			expect(providerDiag).toBeDefined();
			expect(topicDiag).toBeDefined();
		});

		it("should validate worker trigger requires queue", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { worker: {} },
					steps: [],
					nodes: {},
				}),
			);
			const queueDiag = diagnostics.find((d) => d.message.includes('"queue"'));
			expect(queueDiag).toBeDefined();
		});

		it("should accept valid webhook trigger", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { webhook: { source: "github", events: ["push"] } },
					steps: [],
					nodes: {},
				}),
			);
			expect(diagnostics).toHaveLength(0);
		});

		it("should accept valid worker trigger", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { worker: { queue: "email-jobs" } },
					steps: [],
					nodes: {},
				}),
			);
			expect(diagnostics).toHaveLength(0);
		});
	});

	describe("step validation", () => {
		it("should report missing step name", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { http: { method: "GET", path: "/" } },
					steps: [{ node: "@blok/api-call", type: "module" }],
					nodes: {},
				}),
			);
			const nameDiag = diagnostics.find((d) => d.message.includes('"name"'));
			expect(nameDiag).toBeDefined();
		});

		it("should report missing step node", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { http: { method: "GET", path: "/" } },
					steps: [{ name: "step1", type: "module" }],
					nodes: {},
				}),
			);
			const nodeDiag = diagnostics.find((d) => d.message.includes('"node"'));
			expect(nodeDiag).toBeDefined();
		});

		it("should report missing step type", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { http: { method: "GET", path: "/" } },
					steps: [{ name: "step1", node: "@blok/api-call" }],
					nodes: {},
				}),
			);
			const typeDiag = diagnostics.find((d) => d.message.includes('"type"'));
			expect(typeDiag).toBeDefined();
		});

		it("should report invalid step type", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { http: { method: "GET", path: "/" } },
					steps: [{ name: "step1", node: "@blok/api-call", type: "invalid" }],
					nodes: { step1: {} },
				}),
			);
			const typeDiag = diagnostics.find((d) => d.message.includes("Invalid step type"));
			expect(typeDiag).toBeDefined();
		});

		it("should report duplicate step names", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { http: { method: "GET", path: "/" } },
					steps: [
						{ name: "step1", node: "@blok/api-call", type: "module" },
						{ name: "step1", node: "@blok/if-else", type: "module" },
					],
					nodes: { step1: {} },
				}),
			);
			const dupDiag = diagnostics.find((d) => d.message.includes("Duplicate step name"));
			expect(dupDiag).toBeDefined();
		});

		it("should report invalid runtime", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { http: { method: "GET", path: "/" } },
					steps: [{ name: "step1", node: "my-node", type: "local", runtime: "invalid" }],
					nodes: { step1: {} },
				}),
			);
			const runtimeDiag = diagnostics.find((d) => d.message.includes("Invalid runtime"));
			expect(runtimeDiag).toBeDefined();
		});

		it("should accept valid runtime", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { http: { method: "GET", path: "/" } },
					steps: [{ name: "step1", node: "my-node", type: "local", runtime: "python3" }],
					nodes: { step1: {} },
				}),
			);
			expect(diagnostics).toHaveLength(0);
		});
	});

	describe("node reference validation", () => {
		it("should warn when step references undefined node", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { http: { method: "GET", path: "/" } },
					steps: [{ name: "api-call", node: "@blok/api-call", type: "module" }],
					nodes: {},
				}),
			);
			const refDiag = diagnostics.find((d) => d.message.includes("not defined in"));
			expect(refDiag).toBeDefined();
			expect(refDiag!.severity).toBe(DiagnosticSeverity.Warning);
		});

		it("should warn about unused nodes", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { http: { method: "GET", path: "/" } },
					steps: [{ name: "step1", node: "@blok/api-call", type: "module" }],
					nodes: { step1: {}, unused_node: {} },
				}),
			);
			const unusedDiag = diagnostics.find((d) => d.message.includes("not referenced"));
			expect(unusedDiag).toBeDefined();
			expect(unusedDiag!.severity).toBe(DiagnosticSeverity.Information);
		});

		it("should not warn about nodes used in conditions", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "test",
					version: "1.0.0",
					trigger: { http: { method: "GET", path: "/" } },
					steps: [{ name: "router", node: "@blok/if-else", type: "module" }],
					nodes: {
						router: {
							conditions: [
								{
									type: "if",
									steps: [{ name: "nested-step", node: "some-node", type: "module" }],
								},
							],
						},
						"nested-step": {},
					},
				}),
			);
			const unusedDiag = diagnostics.find(
				(d) => d.message.includes("nested-step") && d.message.includes("not referenced"),
			);
			expect(unusedDiag).toBeUndefined();
		});
	});

	describe("valid workflows", () => {
		it("should produce no diagnostics for a valid HTTP workflow", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "user-api",
					version: "1.0.0",
					description: "User management API",
					trigger: { http: { method: "GET", path: "/api/users" } },
					steps: [{ name: "fetch-users", node: "@blok/api-call", type: "module" }],
					nodes: {
						"fetch-users": {
							inputs: { url: "https://api.example.com/users" },
						},
					},
				}),
			);
			expect(diagnostics).toHaveLength(0);
		});

		it("should produce no diagnostics for a valid queue workflow", () => {
			const diagnostics = validateWorkflow(
				JSON.stringify({
					name: "event-processor",
					version: "2.0.0",
					trigger: { queue: { provider: "kafka", topic: "events" } },
					steps: [{ name: "process", node: "./nodes/process-event", type: "local" }],
					nodes: { process: {} },
				}),
			);
			expect(diagnostics).toHaveLength(0);
		});
	});

	describe("diagnostic source", () => {
		it("should set source to 'blok' on all diagnostics", () => {
			const diagnostics = validateWorkflow("{}");
			for (const diag of diagnostics) {
				expect(diag.source).toBe("blok");
			}
		});
	});
});
