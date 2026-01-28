/**
 * WorkflowValidator Tests
 *
 * Tests structural validation for AI-generated workflow JSON configurations
 */

import { describe, expect, it } from "vitest";
import { validateWorkflow } from "./WorkflowValidator.js";

describe("WorkflowValidator", () => {
	describe("validateWorkflow - JSON parsing", () => {
		it("should fail for invalid JSON", () => {
			const result = validateWorkflow("not valid json {{{");
			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]).toContain("Invalid JSON");
		});

		it("should fail for empty string", () => {
			const result = validateWorkflow("");
			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain("Invalid JSON");
		});
	});

	describe("validateWorkflow - top-level structure", () => {
		it("should pass for valid minimal workflow", () => {
			const workflow = JSON.stringify({
				name: "test-workflow",
				description: "A test workflow",
				version: "1.0.0",
				trigger: { http: { method: "GET", path: "/" } },
				steps: [{ name: "step1", node: "some-node", type: "module" }],
				nodes: { "step1": { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(true);
			expect(result.errors.length).toBe(0);
		});

		it("should fail for missing name", () => {
			const workflow = JSON.stringify({
				description: "test",
				version: "1.0.0",
				trigger: { http: {} },
				steps: [{ name: "s", node: "n", type: "module" }],
				nodes: { s: { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("name"))).toBe(true);
		});

		it("should fail for missing version", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				trigger: { http: {} },
				steps: [{ name: "s", node: "n", type: "module" }],
				nodes: { s: { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("version"))).toBe(true);
		});

		it("should warn for non-semver version", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "latest",
				trigger: { http: { method: "GET" } },
				steps: [{ name: "s", node: "n", type: "module" }],
				nodes: { s: { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.warnings.some(w => w.includes("semver"))).toBe(true);
		});

		it("should fail for missing trigger", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				steps: [{ name: "s", node: "n", type: "module" }],
				nodes: { s: { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("trigger"))).toBe(true);
		});

		it("should fail for missing steps", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { http: {} },
				nodes: {},
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("steps"))).toBe(true);
		});

		it("should fail for empty steps array", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { http: {} },
				steps: [],
				nodes: {},
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("steps"))).toBe(true);
		});

		it("should fail for missing nodes", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { http: {} },
				steps: [{ name: "s", node: "n", type: "module" }],
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("nodes"))).toBe(true);
		});
	});

	describe("validateWorkflow - trigger validation", () => {
		it("should fail for multiple trigger types", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { http: {}, cron: {} },
				steps: [{ name: "s", node: "n", type: "module" }],
				nodes: { s: { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("exactly one"))).toBe(true);
		});

		it("should fail for invalid trigger type", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { ftp: {} },
				steps: [{ name: "s", node: "n", type: "module" }],
				nodes: { s: { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("Invalid trigger type"))).toBe(true);
		});

		it("should pass for valid http trigger", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { http: { method: "GET", path: "/api/test", accept: "application/json" } },
				steps: [{ name: "s", node: "n", type: "module" }],
				nodes: { s: { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(true);
		});

		it("should fail for invalid HTTP method", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { http: { method: "FETCH" } },
				steps: [{ name: "s", node: "n", type: "module" }],
				nodes: { s: { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("Invalid HTTP method"))).toBe(true);
		});

		it("should pass for valid queue trigger", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { queue: { provider: "kafka", topic: "events" } },
				steps: [{ name: "s", node: "n", type: "module" }],
				nodes: { s: { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(true);
		});

		it("should fail for queue trigger missing provider", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { queue: { topic: "events" } },
				steps: [{ name: "s", node: "n", type: "module" }],
				nodes: { s: { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("provider"))).toBe(true);
		});

		it("should fail for queue trigger with invalid provider", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { queue: { provider: "oracle", topic: "events" } },
				steps: [{ name: "s", node: "n", type: "module" }],
				nodes: { s: { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("Invalid queue provider"))).toBe(true);
		});

		it("should pass for valid cron trigger", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { cron: { schedule: "0 * * * *", timezone: "UTC" } },
				steps: [{ name: "s", node: "n", type: "module" }],
				nodes: { s: { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(true);
		});

		it("should fail for invalid cron expression", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { cron: { schedule: "invalid cron" } },
				steps: [{ name: "s", node: "n", type: "module" }],
				nodes: { s: { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("Invalid cron expression"))).toBe(true);
		});

		it("should pass for valid pubsub trigger", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { pubsub: { provider: "gcp", topic: "events", subscription: "sub1" } },
				steps: [{ name: "s", node: "n", type: "module" }],
				nodes: { s: { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(true);
		});

		it("should fail for pubsub missing subscription", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { pubsub: { provider: "gcp", topic: "events" } },
				steps: [{ name: "s", node: "n", type: "module" }],
				nodes: { s: { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("subscription"))).toBe(true);
		});

		it("should pass for valid webhook trigger", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { webhook: { source: "github", events: ["push"] } },
				steps: [{ name: "s", node: "n", type: "module" }],
				nodes: { s: { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(true);
		});

		it("should fail for webhook trigger with empty events", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { webhook: { source: "github", events: [] } },
				steps: [{ name: "s", node: "n", type: "module" }],
				nodes: { s: { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("events"))).toBe(true);
		});

		it("should pass for valid websocket trigger", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { websocket: { events: ["message"], path: "/ws" } },
				steps: [{ name: "s", node: "n", type: "module" }],
				nodes: { s: { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(true);
		});

		it("should pass for valid sse trigger", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { sse: { events: ["update"], channels: ["feed"] } },
				steps: [{ name: "s", node: "n", type: "module" }],
				nodes: { s: { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(true);
		});
	});

	describe("validateWorkflow - steps validation", () => {
		it("should fail for step missing name", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [{ node: "n", type: "module" }],
				nodes: {},
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("name"))).toBe(true);
		});

		it("should fail for step missing node", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [{ name: "s", type: "module" }],
				nodes: { s: { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("node"))).toBe(true);
		});

		it("should fail for duplicate step names", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [
					{ name: "s1", node: "n1", type: "module" },
					{ name: "s1", node: "n2", type: "module" },
				],
				nodes: { s1: { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("Duplicate"))).toBe(true);
		});
	});

	describe("validateWorkflow - nodes cross-reference", () => {
		it("should fail when step has no matching node", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [{ name: "missing-node", node: "n", type: "module" }],
				nodes: { "other-node": { inputs: {} } },
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("missing-node") && e.includes("no matching"))).toBe(true);
		});

		it("should pass when all steps have matching nodes", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [
					{ name: "s1", node: "n1", type: "module" },
					{ name: "s2", node: "n2", type: "module" },
				],
				nodes: {
					s1: { inputs: {} },
					s2: { inputs: { data: "test" } },
				},
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(true);
		});
	});

	describe("validateWorkflow - conditional nodes", () => {
		it("should pass for valid conditional routing", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { http: { method: "*", path: "/:action?" } },
				steps: [{ name: "router", node: "@nanoservice-ts/if-else", type: "module" }],
				nodes: {
					router: {
						conditions: [
							{
								type: "if",
								condition: "ctx.request.method.toLowerCase() === \"get\"",
								steps: [{ name: "get-data", node: "fetch", type: "module" }],
							},
							{
								type: "else",
								steps: [{ name: "error", node: "error", type: "module" }],
							},
						],
					},
					"get-data": { inputs: {} },
					error: { inputs: { message: "Not allowed" } },
				},
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(true);
		});

		it("should fail for condition missing condition string", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [{ name: "router", node: "if-else", type: "module" }],
				nodes: {
					router: {
						conditions: [
							{
								type: "if",
								steps: [{ name: "s", node: "n", type: "module" }],
							},
						],
					},
					s: { inputs: {} },
				},
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("condition"))).toBe(true);
		});

		it("should fail when conditional step has no matching node entry", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [{ name: "router", node: "if-else", type: "module" }],
				nodes: {
					router: {
						conditions: [
							{
								type: "if",
								condition: "ctx.request.method === 'GET'",
								steps: [{ name: "missing-step", node: "n", type: "module" }],
							},
							{
								type: "else",
								steps: [{ name: "fallback", node: "error", type: "module" }],
							},
						],
					},
				},
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("missing-step"))).toBe(true);
		});

		it("should fail when else is not last condition", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [{ name: "router", node: "if-else", type: "module" }],
				nodes: {
					router: {
						conditions: [
							{
								type: "else",
								steps: [{ name: "s1", node: "n", type: "module" }],
							},
							{
								type: "if",
								condition: "ctx.request.method === 'GET'",
								steps: [{ name: "s2", node: "n", type: "module" }],
							},
						],
					},
					s1: { inputs: {} },
					s2: { inputs: {} },
				},
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("else") && e.includes("last"))).toBe(true);
		});

		it("should warn when no else branch exists", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [{ name: "router", node: "if-else", type: "module" }],
				nodes: {
					router: {
						conditions: [
							{
								type: "if",
								condition: "ctx.request.method === 'GET'",
								steps: [{ name: "s1", node: "n", type: "module" }],
							},
						],
					},
					s1: { inputs: {} },
				},
			});

			const result = validateWorkflow(workflow);
			expect(result.warnings.some(w => w.includes("else"))).toBe(true);
		});

		it("should fail for condition with empty steps array", () => {
			const workflow = JSON.stringify({
				name: "test",
				description: "test",
				version: "1.0.0",
				trigger: { http: { method: "GET" } },
				steps: [{ name: "router", node: "if-else", type: "module" }],
				nodes: {
					router: {
						conditions: [
							{
								type: "if",
								condition: "ctx.request.method === 'GET'",
								steps: [],
							},
						],
					},
				},
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("at least one step"))).toBe(true);
		});
	});

	describe("validateWorkflow - real-world examples", () => {
		it("should pass for countries API proxy workflow", () => {
			const workflow = JSON.stringify({
				name: "World Countries",
				description: "Workflow description",
				version: "1.0.0",
				trigger: {
					http: { method: "GET", path: "/", accept: "application/json" },
				},
				steps: [
					{ name: "get-countries-api", node: "@nanoservice-ts/api-call", type: "module" },
				],
				nodes: {
					"get-countries-api": {
						inputs: {
							url: "https://countriesnow.space/api/v0.1/countries/capital",
							method: "GET",
							headers: { "Content-Type": "application/json" },
							responseType: "application/json",
						},
					},
				},
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(true);
			expect(result.errors.length).toBe(0);
		});

		it("should pass for CRUD workflow with conditional routing", () => {
			const workflow = JSON.stringify({
				name: "feedback",
				description: "",
				version: "1.0.0",
				trigger: {
					http: { method: "*", path: "/:function?/:id?", accept: "application/json" },
				},
				steps: [
					{ name: "filter-request", node: "@nanoservice-ts/if-else", type: "module" },
				],
				nodes: {
					"filter-request": {
						conditions: [
							{
								type: "if",
								steps: [{ name: "feedback-ui", node: "feedback-ui", type: "module" }],
								condition: "ctx.request.method.toLowerCase() === \"get\" && ctx.request.params.function === ''",
							},
							{
								type: "if",
								steps: [
									{ name: "generate-sentiment", node: "generate-sentiment", type: "runtime.python3" },
									{ name: "save-feedback", node: "memory-storage", type: "module" },
								],
								condition: "ctx.request.method.toLowerCase() === \"post\" && ctx.request.params.function === \"create\"",
							},
							{
								type: "else",
								steps: [{ name: "method-not-allowed", node: "error", type: "module" }],
							},
						],
					},
					"feedback-ui": { inputs: {} },
					"generate-sentiment": { inputs: { comment: "${ctx.request.body.comment}" } },
					"save-feedback": { inputs: { action: "set", key: "${ctx.request.body.id}" } },
					"method-not-allowed": { inputs: { message: "Method not allowed" } },
				},
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(true);
			expect(result.errors.length).toBe(0);
		});

		it("should pass for queue-triggered workflow", () => {
			const workflow = JSON.stringify({
				name: "Event Processor",
				description: "Processes events from Kafka",
				version: "1.0.0",
				trigger: {
					queue: {
						provider: "kafka",
						topic: "user-events",
						consumerGroup: "event-processor",
						ack: true,
					},
				},
				steps: [
					{ name: "process-event", node: "event-handler", type: "module" },
				],
				nodes: {
					"process-event": {
						inputs: { eventType: "${ctx.request.body.type}" },
					},
				},
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(true);
		});

		it("should pass for cron-triggered workflow", () => {
			const workflow = JSON.stringify({
				name: "Daily Report",
				description: "Generates daily reports",
				version: "1.0.0",
				trigger: {
					cron: { schedule: "0 8 * * *", timezone: "America/New_York", overlap: false },
				},
				steps: [
					{ name: "fetch-metrics", node: "@nanoservice-ts/api-call", type: "module" },
				],
				nodes: {
					"fetch-metrics": {
						inputs: { url: "${ctx.env.METRICS_API_URL}", method: "GET" },
					},
				},
			});

			const result = validateWorkflow(workflow);
			expect(result.valid).toBe(true);
		});
	});
});
