import { describe, it, expect, beforeEach } from "vitest";
import { WorkflowVisualizer, type WorkflowDef } from "../WorkflowVisualizer";

// -- Fixtures --

const httpWorkflow: WorkflowDef = {
	name: "user-api",
	version: "1.0.0",
	description: "User management API",
	trigger: { http: { method: "GET", path: "/users/:id" } },
	steps: [
		{ name: "validate", node: "validator", type: "local" },
		{ name: "fetch-user", node: "db-query", type: "local" },
		{ name: "format", node: "formatter", type: "local" },
	],
	nodes: { validator: {}, "db-query": {}, formatter: {} },
};

const cronWorkflow: WorkflowDef = {
	name: "daily-report",
	version: "2.0.0",
	trigger: { cron: { schedule: "0 9 * * *" } },
	steps: [
		{ name: "gather-data", node: "data-collector", type: "local" },
		{ name: "generate", node: "report-gen", type: "runtime.python3", runtime: "python3" },
	],
	nodes: { "data-collector": {}, "report-gen": {} },
};

const conditionWorkflow: WorkflowDef = {
	name: "conditional-flow",
	version: "1.0.0",
	trigger: { http: { method: "POST", path: "/process" } },
	steps: [
		{
			name: "check",
			node: "validator",
			type: "local",
			conditions: [
				{
					type: "if",
					expression: "ctx.data.valid === true",
					steps: [{ name: "success-path", node: "success-handler", type: "local" }],
				},
				{
					type: "else",
					steps: [{ name: "error-path", node: "error-handler", type: "local" }],
				},
			],
		},
		{ name: "finalize", node: "finalizer", type: "local" },
	],
	nodes: { validator: {}, "success-handler": {}, "error-handler": {}, finalizer: {} },
};

const webhookWorkflow: WorkflowDef = {
	name: "github-handler",
	version: "1.0.0",
	trigger: { webhook: { source: "github", events: ["push", "pull_request"] } },
	steps: [{ name: "process", node: "gh-processor", type: "local" }],
	nodes: { "gh-processor": {} },
};

const wsWorkflow: WorkflowDef = {
	name: "live-chat",
	version: "1.0.0",
	trigger: { websocket: { path: "/ws/chat" } },
	steps: [{ name: "handle-msg", node: "msg-handler", type: "local" }],
	nodes: { "msg-handler": {} },
};

const queueWorkflow: WorkflowDef = {
	name: "process-order",
	version: "1.0.0",
	trigger: { queue: { provider: "kafka", topic: "orders" } },
	steps: [{ name: "process", node: "order-processor", type: "local" }],
	nodes: { "order-processor": {} },
};

const grpcWorkflow: WorkflowDef = {
	name: "grpc-service",
	version: "1.0.0",
	trigger: { grpc: { service: "UserService", method: "GetUser" } },
	steps: [{ name: "get", node: "user-getter", type: "local" }],
	nodes: { "user-getter": {} },
};

const pubsubWorkflow: WorkflowDef = {
	name: "event-handler",
	version: "1.0.0",
	trigger: { pubsub: { provider: "gcp", topic: "events" } },
	steps: [{ name: "handle", node: "event-handler-node", type: "local" }],
	nodes: { "event-handler-node": {} },
};

const sseWorkflow: WorkflowDef = {
	name: "live-updates",
	version: "1.0.0",
	trigger: { sse: { path: "/events/stream" } },
	steps: [{ name: "stream", node: "data-streamer", type: "local" }],
	nodes: { "data-streamer": {} },
};

const workerWorkflow: WorkflowDef = {
	name: "background-job",
	version: "1.0.0",
	trigger: { worker: { queue: "emails" } },
	steps: [{ name: "send", node: "email-sender", type: "local" }],
	nodes: { "email-sender": {} },
};

const manualWorkflow: WorkflowDef = {
	name: "manual-task",
	version: "1.0.0",
	trigger: { manual: {} },
	steps: [{ name: "run", node: "task-runner", type: "local" }],
	nodes: { "task-runner": {} },
};

describe("WorkflowVisualizer", () => {
	let viz: WorkflowVisualizer;

	beforeEach(() => {
		viz = new WorkflowVisualizer();
	});

	describe("Constructor", () => {
		it("should create with default config", () => {
			expect(viz).toBeDefined();
		});

		it("should accept custom config", () => {
			const custom = new WorkflowVisualizer({
				direction: "LR",
				showTrigger: false,
				showTypes: false,
				showConditions: false,
				theme: "dark",
				title: "My Workflows",
			});
			expect(custom).toBeDefined();
		});
	});

	describe("addWorkflow", () => {
		it("should add a single workflow", () => {
			viz.addWorkflow(httpWorkflow);
			const summary = viz.getSummary();
			expect(summary).toHaveLength(1);
			expect(summary[0].name).toBe("user-api");
		});

		it("should add multiple workflows via addWorkflows", () => {
			viz.addWorkflows([httpWorkflow, cronWorkflow]);
			const summary = viz.getSummary();
			expect(summary).toHaveLength(2);
		});
	});

	describe("toMermaid", () => {
		it("should handle empty workflows", () => {
			const output = viz.toMermaid();
			expect(output).toContain("graph TB");
			expect(output).toContain("No workflows");
		});

		it("should generate HTTP workflow diagram", () => {
			viz.addWorkflow(httpWorkflow);
			const output = viz.toMermaid();

			expect(output).toContain("graph TB");
			expect(output).toContain("HTTP GET /users/:id");
			expect(output).toContain("validate");
			expect(output).toContain("fetch_user");
			expect(output).toContain("format");
			expect(output).toContain("End");
			expect(output).toContain(":::trigger");
			expect(output).toContain(":::step");
			expect(output).toContain(":::endNode");
		});

		it("should include CSS class definitions", () => {
			viz.addWorkflow(httpWorkflow);
			const output = viz.toMermaid();

			expect(output).toContain("classDef trigger");
			expect(output).toContain("classDef step");
			expect(output).toContain("classDef condition");
			expect(output).toContain("classDef endNode");
		});

		it("should show type labels when showTypes is true", () => {
			viz.addWorkflow(cronWorkflow);
			const output = viz.toMermaid();

			expect(output).toContain("[local]");
			expect(output).toContain("[runtime.python3 / python3]");
		});

		it("should hide type labels when showTypes is false", () => {
			const noTypes = new WorkflowVisualizer({ showTypes: false });
			noTypes.addWorkflow(cronWorkflow);
			const output = noTypes.toMermaid();

			expect(output).not.toContain("[local]");
			expect(output).not.toContain("[runtime.python3]");
		});

		it("should show conditions with branches", () => {
			viz.addWorkflow(conditionWorkflow);
			const output = viz.toMermaid();

			expect(output).toContain("condition");
			expect(output).toContain(":::condition");
			expect(output).toContain("success_path");
			expect(output).toContain("error_path");
		});

		it("should hide conditions when showConditions is false", () => {
			const noCond = new WorkflowVisualizer({ showConditions: false });
			noCond.addWorkflow(conditionWorkflow);
			const output = noCond.toMermaid();

			expect(output).not.toContain(":::condition");
		});

		it("should support LR direction", () => {
			const lr = new WorkflowVisualizer({ direction: "LR" });
			lr.addWorkflow(httpWorkflow);
			const output = lr.toMermaid();

			expect(output).toContain("graph LR");
		});

		it("should apply dark theme", () => {
			const dark = new WorkflowVisualizer({ theme: "dark" });
			dark.addWorkflow(httpWorkflow);
			const output = dark.toMermaid();

			expect(output).toContain("%%{init:");
			expect(output).toContain("'dark'");
		});

		it("should include title comment", () => {
			const titled = new WorkflowVisualizer({ title: "My API Graph" });
			titled.addWorkflow(httpWorkflow);
			const output = titled.toMermaid();

			expect(output).toContain("%% My API Graph");
		});

		it("should use subgraphs for multiple workflows", () => {
			viz.addWorkflows([httpWorkflow, cronWorkflow]);
			const output = viz.toMermaid();

			expect(output).toContain("subgraph user_api");
			expect(output).toContain("subgraph daily_report");
			expect(output).toContain("end");
		});

		it("should handle trigger hidden", () => {
			const noTrigger = new WorkflowVisualizer({ showTrigger: false });
			noTrigger.addWorkflow(httpWorkflow);
			const output = noTrigger.toMermaid();

			expect(output).not.toContain("HTTP GET");
			expect(output).toContain("validate");
		});

		it("should generate cron trigger label", () => {
			viz.addWorkflow(cronWorkflow);
			const output = viz.toMermaid();
			expect(output).toContain("Cron: 0 9 * * *");
		});

		it("should generate webhook trigger label", () => {
			viz.addWorkflow(webhookWorkflow);
			const output = viz.toMermaid();
			expect(output).toContain("Webhook: github [push, pull_request]");
		});

		it("should generate websocket trigger label", () => {
			viz.addWorkflow(wsWorkflow);
			const output = viz.toMermaid();
			expect(output).toContain("WebSocket: /ws/chat");
		});

		it("should generate queue trigger label", () => {
			viz.addWorkflow(queueWorkflow);
			const output = viz.toMermaid();
			expect(output).toContain("Queue: kafka/orders");
		});

		it("should generate grpc trigger label", () => {
			viz.addWorkflow(grpcWorkflow);
			const output = viz.toMermaid();
			expect(output).toContain("gRPC UserService.GetUser");
		});

		it("should generate pubsub trigger label", () => {
			viz.addWorkflow(pubsubWorkflow);
			const output = viz.toMermaid();
			expect(output).toContain("PubSub: gcp/events");
		});

		it("should generate SSE trigger label", () => {
			viz.addWorkflow(sseWorkflow);
			const output = viz.toMermaid();
			expect(output).toContain("SSE: /events/stream");
		});

		it("should generate worker trigger label", () => {
			viz.addWorkflow(workerWorkflow);
			const output = viz.toMermaid();
			expect(output).toContain("Worker: emails");
		});

		it("should generate manual trigger label", () => {
			viz.addWorkflow(manualWorkflow);
			const output = viz.toMermaid();
			expect(output).toContain("Manual");
		});
	});

	describe("toDot", () => {
		it("should handle empty workflows", () => {
			const output = viz.toDot();
			expect(output).toContain("digraph G");
			expect(output).toContain("No workflows");
		});

		it("should generate DOT syntax for HTTP workflow", () => {
			viz.addWorkflow(httpWorkflow);
			const output = viz.toDot();

			expect(output).toContain("digraph G {");
			expect(output).toContain("rankdir=TB");
			expect(output).toContain("shape=hexagon");
			expect(output).toContain("shape=box");
			expect(output).toContain("shape=ellipse");
			expect(output).toContain("trigger");
			expect(output).toContain("validate");
			expect(output).toContain("end_node");
			expect(output).toContain("}");
		});

		it("should include fillcolors", () => {
			viz.addWorkflow(httpWorkflow);
			const output = viz.toDot();

			expect(output).toContain('#4CAF50'); // trigger green
			expect(output).toContain('#2196F3'); // step blue
			expect(output).toContain('#9E9E9E'); // end grey
		});

		it("should use subgraphs for multiple workflows", () => {
			viz.addWorkflows([httpWorkflow, cronWorkflow]);
			const output = viz.toDot();

			expect(output).toContain("subgraph cluster_user_api");
			expect(output).toContain("subgraph cluster_daily_report");
		});

		it("should include title as label", () => {
			const titled = new WorkflowVisualizer({ title: "My Services" });
			titled.addWorkflow(httpWorkflow);
			const output = titled.toDot();

			expect(output).toContain('label="My Services"');
		});

		it("should show conditions with diamond shape", () => {
			viz.addWorkflow(conditionWorkflow);
			const output = viz.toDot();

			expect(output).toContain("shape=diamond");
			expect(output).toContain('#FF9800'); // condition orange
		});

		it("should use dashed edges for condition branches", () => {
			viz.addWorkflow(conditionWorkflow);
			const output = viz.toDot();

			expect(output).toContain("style=dashed");
		});
	});

	describe("toAscii", () => {
		it("should handle empty workflows", () => {
			const output = viz.toAscii();
			expect(output).toBe("[No workflows]");
		});

		it("should generate ASCII box for workflow", () => {
			viz.addWorkflow(httpWorkflow);
			const output = viz.toAscii();

			expect(output).toContain("╔");
			expect(output).toContain("╗");
			expect(output).toContain("╚");
			expect(output).toContain("╝");
			expect(output).toContain("user-api v1.0.0");
		});

		it("should show step icons", () => {
			viz.addWorkflow(httpWorkflow);
			const output = viz.toAscii();

			expect(output).toContain("⚡"); // trigger
			expect(output).toContain("▪️"); // step
		});

		it("should show flow arrows between steps", () => {
			viz.addWorkflow(httpWorkflow);
			const output = viz.toAscii();

			expect(output).toContain("│");
			expect(output).toContain("▼");
		});
	});

	describe("getSummary", () => {
		it("should return empty array for no workflows", () => {
			expect(viz.getSummary()).toEqual([]);
		});

		it("should return summary for HTTP workflow", () => {
			viz.addWorkflow(httpWorkflow);
			const [summary] = viz.getSummary();

			expect(summary.name).toBe("user-api");
			expect(summary.version).toBe("1.0.0");
			expect(summary.triggerType).toBe("http");
			expect(summary.triggerDetail).toBe("HTTP GET /users/:id");
			expect(summary.stepCount).toBe(3);
			expect(summary.nodeCount).toBe(3);
			expect(summary.hasConditions).toBe(false);
		});

		it("should detect conditions", () => {
			viz.addWorkflow(conditionWorkflow);
			const [summary] = viz.getSummary();

			expect(summary.hasConditions).toBe(true);
		});

		it("should count nested steps in conditions", () => {
			viz.addWorkflow(conditionWorkflow);
			const [summary] = viz.getSummary();

			// 2 top-level + 1 success-path + 1 error-path = 4
			expect(summary.stepCount).toBe(4);
		});

		it("should detect runtimes from step types", () => {
			viz.addWorkflow(cronWorkflow);
			const [summary] = viz.getSummary();

			expect(summary.runtimes).toContain("python3");
		});

		it("should return summaries for all trigger types", () => {
			viz.addWorkflows([
				httpWorkflow, cronWorkflow, queueWorkflow,
				webhookWorkflow, wsWorkflow, grpcWorkflow,
				pubsubWorkflow, sseWorkflow, workerWorkflow,
				manualWorkflow,
			]);
			const summaries = viz.getSummary();

			expect(summaries).toHaveLength(10);
			const triggerTypes = summaries.map((s) => s.triggerType);
			expect(triggerTypes).toContain("http");
			expect(triggerTypes).toContain("cron");
			expect(triggerTypes).toContain("queue");
			expect(triggerTypes).toContain("webhook");
			expect(triggerTypes).toContain("websocket");
			expect(triggerTypes).toContain("grpc");
			expect(triggerTypes).toContain("pubsub");
			expect(triggerTypes).toContain("sse");
			expect(triggerTypes).toContain("worker");
			expect(triggerTypes).toContain("manual");
		});
	});
});
