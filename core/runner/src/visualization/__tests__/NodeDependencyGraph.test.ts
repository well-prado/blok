import { beforeEach, describe, expect, it } from "vitest";
import { NodeDependencyGraph } from "../NodeDependencyGraph";
import type { WorkflowDef } from "../WorkflowVisualizer";

// -- Fixtures --

const userApiWorkflow: WorkflowDef = {
	name: "user-api",
	version: "1.0.0",
	trigger: { http: { method: "GET", path: "/users/:id" } },
	steps: [
		{ name: "validate", node: "validator", type: "local" },
		{ name: "fetch-user", node: "db-query", type: "local" },
		{ name: "format", node: "formatter", type: "local" },
	],
	nodes: { validator: {}, "db-query": {}, formatter: {} },
};

const orderWorkflow: WorkflowDef = {
	name: "process-order",
	version: "1.0.0",
	trigger: { queue: { provider: "kafka", topic: "orders" } },
	steps: [
		{ name: "validate-order", node: "validator", type: "local" },
		{ name: "process", node: "order-processor", type: "runtime.python3", runtime: "python3" },
		{ name: "notify", node: "email-sender", type: "runtime.go", runtime: "go" },
	],
	nodes: { validator: {}, "order-processor": {}, "email-sender": {} },
};

const reportWorkflow: WorkflowDef = {
	name: "daily-report",
	version: "2.0.0",
	trigger: { cron: { schedule: "0 9 * * *" } },
	steps: [
		{ name: "gather", node: "db-query", type: "local" },
		{ name: "generate", node: "report-gen", type: "runtime.python3", runtime: "python3" },
	],
	nodes: { "db-query": {}, "report-gen": {} },
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

const workflowWithOrphan: WorkflowDef = {
	name: "orphan-test",
	version: "1.0.0",
	trigger: { manual: {} },
	steps: [{ name: "step1", node: "used-node", type: "local" }],
	nodes: { "used-node": {}, "orphan-node": {} },
};

// -- Tests --

describe("NodeDependencyGraph", () => {
	let graph: NodeDependencyGraph;

	beforeEach(() => {
		graph = new NodeDependencyGraph();
	});

	describe("Basic Functionality", () => {
		it("should return empty results when no workflows added", () => {
			expect(graph.getNodeMap().size).toBe(0);
			expect(graph.getEdges().length).toBe(0);
			expect(graph.getSharedNodes().length).toBe(0);
		});

		it("should add a single workflow", () => {
			graph.addWorkflow(userApiWorkflow);
			const nodeMap = graph.getNodeMap();
			expect(nodeMap.size).toBe(3);
			expect(nodeMap.has("validator")).toBe(true);
			expect(nodeMap.has("db-query")).toBe(true);
			expect(nodeMap.has("formatter")).toBe(true);
		});

		it("should add multiple workflows", () => {
			graph.addWorkflows([userApiWorkflow, orderWorkflow]);
			const nodeMap = graph.getNodeMap();
			// validator, db-query, formatter, order-processor, email-sender
			expect(nodeMap.size).toBe(5);
		});
	});

	describe("Node Map Analysis", () => {
		it("should track which workflows use each node", () => {
			graph.addWorkflows([userApiWorkflow, orderWorkflow]);
			const nodeMap = graph.getNodeMap();

			const validator = nodeMap.get("validator")!;
			expect(validator.usedInWorkflows).toContain("user-api");
			expect(validator.usedInWorkflows).toContain("process-order");
		});

		it("should track step references per node", () => {
			graph.addWorkflow(userApiWorkflow);
			const nodeMap = graph.getNodeMap();

			const dbQuery = nodeMap.get("db-query")!;
			expect(dbQuery.usedInSteps.length).toBe(1);
			expect(dbQuery.usedInSteps[0].stepName).toBe("fetch-user");
			expect(dbQuery.usedInSteps[0].workflowName).toBe("user-api");
		});

		it("should track runtime types", () => {
			graph.addWorkflow(orderWorkflow);
			const nodeMap = graph.getNodeMap();

			const processor = nodeMap.get("order-processor")!;
			expect(processor.runtimes.has("python3")).toBe(true);

			const sender = nodeMap.get("email-sender")!;
			expect(sender.runtimes.has("go")).toBe(true);
		});

		it("should track step types", () => {
			graph.addWorkflow(orderWorkflow);
			const nodeMap = graph.getNodeMap();

			const processor = nodeMap.get("order-processor")!;
			expect(processor.types.has("runtime.python3")).toBe(true);
		});
	});

	describe("Edge Detection", () => {
		it("should detect sequential edges", () => {
			graph.addWorkflow(userApiWorkflow);
			const edges = graph.getEdges();

			expect(edges.length).toBe(2);
			expect(edges[0]).toEqual({
				from: "validator",
				to: "db-query",
				workflow: "user-api",
				edgeType: "sequential",
			});
			expect(edges[1]).toEqual({
				from: "db-query",
				to: "formatter",
				workflow: "user-api",
				edgeType: "sequential",
			});
		});

		it("should detect conditional edges", () => {
			graph.addWorkflow(conditionWorkflow);
			const edges = graph.getEdges();

			const conditionalEdges = edges.filter((e) => e.edgeType === "conditional");
			expect(conditionalEdges.length).toBe(2);
			expect(conditionalEdges[0].from).toBe("validator");
			expect(conditionalEdges[0].to).toBe("success-handler");
			expect(conditionalEdges[1].from).toBe("validator");
			expect(conditionalEdges[1].to).toBe("error-handler");
		});

		it("should collect edges from multiple workflows", () => {
			graph.addWorkflows([userApiWorkflow, orderWorkflow]);
			const edges = graph.getEdges();

			const userEdges = edges.filter((e) => e.workflow === "user-api");
			const orderEdges = edges.filter((e) => e.workflow === "process-order");

			expect(userEdges.length).toBe(2);
			expect(orderEdges.length).toBe(2);
		});
	});

	describe("Shared Node Detection", () => {
		it("should detect nodes shared across workflows", () => {
			graph.addWorkflows([userApiWorkflow, orderWorkflow]);
			const shared = graph.getSharedNodes();

			expect(shared.length).toBe(1);
			expect(shared[0].nodeId).toBe("validator");
		});

		it("should detect nodes shared across three workflows", () => {
			graph.addWorkflows([userApiWorkflow, reportWorkflow]);
			const shared = graph.getSharedNodes();

			expect(shared.length).toBe(1);
			expect(shared[0].nodeId).toBe("db-query");
		});

		it("should return empty when no nodes are shared", () => {
			graph.addWorkflow(userApiWorkflow);
			const shared = graph.getSharedNodes();
			expect(shared.length).toBe(0);
		});
	});

	describe("Orphan Node Detection", () => {
		it("should detect orphan nodes", () => {
			graph.addWorkflow(workflowWithOrphan);
			const orphans = graph.getOrphanNodes();

			expect(orphans.length).toBe(1);
			expect(orphans[0]).toBe("orphan-node");
		});

		it("should return empty when no orphans exist", () => {
			graph.addWorkflow(userApiWorkflow);
			const orphans = graph.getOrphanNodes();
			expect(orphans.length).toBe(0);
		});
	});

	describe("Filtering", () => {
		it("should filter by workflow name", () => {
			const filtered = new NodeDependencyGraph({ filterWorkflow: "user-api" });
			filtered.addWorkflows([userApiWorkflow, orderWorkflow]);

			const nodeMap = filtered.getNodeMap();
			expect(nodeMap.size).toBe(3); // only user-api nodes
			expect(nodeMap.has("order-processor")).toBe(false);
		});

		it("should filter by node name", () => {
			const filtered = new NodeDependencyGraph({ filterNode: "validator" });
			filtered.addWorkflows([userApiWorkflow, orderWorkflow]);

			const nodeMap = filtered.getNodeMap();
			// validator and its neighbors
			expect(nodeMap.has("validator")).toBe(true);
		});

		it("should return empty for non-existent workflow filter", () => {
			const filtered = new NodeDependencyGraph({ filterWorkflow: "nonexistent" });
			filtered.addWorkflow(userApiWorkflow);

			expect(filtered.getNodeMap().size).toBe(0);
		});

		it("should return empty for non-existent node filter", () => {
			const filtered = new NodeDependencyGraph({ filterNode: "nonexistent" });
			filtered.addWorkflow(userApiWorkflow);

			expect(filtered.getNodeMap().size).toBe(0);
		});
	});

	describe("Statistics", () => {
		it("should compute stats correctly", () => {
			graph.addWorkflows([userApiWorkflow, orderWorkflow]);
			const stats = graph.getStats();

			expect(stats.totalNodes).toBe(5);
			expect(stats.totalEdges).toBe(4);
			expect(stats.totalWorkflows).toBe(2);
			expect(stats.sharedNodes).toBe(1);
			expect(stats.orphanNodes).toBe(0);
			expect(stats.mostUsedNode).not.toBeNull();
			expect(stats.mostUsedNode!.nodeId).toBe("validator");
			expect(stats.mostUsedNode!.count).toBe(2);
		});

		it("should compute stats for empty graph", () => {
			const stats = graph.getStats();
			expect(stats.totalNodes).toBe(0);
			expect(stats.totalEdges).toBe(0);
			expect(stats.totalWorkflows).toBe(0);
		});
	});

	describe("getWorkflowsForNode", () => {
		it("should return workflows that use a specific node", () => {
			graph.addWorkflows([userApiWorkflow, orderWorkflow, reportWorkflow]);
			const workflows = graph.getWorkflowsForNode("db-query");

			expect(workflows).toContain("user-api");
			expect(workflows).toContain("daily-report");
			expect(workflows.length).toBe(2);
		});

		it("should return empty for unknown node", () => {
			graph.addWorkflow(userApiWorkflow);
			expect(graph.getWorkflowsForNode("unknown")).toEqual([]);
		});
	});

	describe("Mermaid Output", () => {
		it("should generate valid Mermaid for single workflow", () => {
			graph.addWorkflow(userApiWorkflow);
			const mermaid = graph.toMermaid();

			expect(mermaid).toContain("graph TB");
			expect(mermaid).toContain("validator");
			expect(mermaid).toContain("db_query");
			expect(mermaid).toContain("formatter");
			expect(mermaid).toContain("classDef node");
		});

		it("should generate Mermaid with workflow boundaries", () => {
			graph.addWorkflows([userApiWorkflow, orderWorkflow]);
			const mermaid = graph.toMermaid();

			expect(mermaid).toContain("subgraph");
			expect(mermaid).toContain("user-api");
			expect(mermaid).toContain("process-order");
		});

		it("should mark shared nodes", () => {
			graph.addWorkflows([userApiWorkflow, orderWorkflow]);
			const mermaid = graph.toMermaid();

			expect(mermaid).toContain("Shared Nodes");
			expect(mermaid).toContain("classDef shared");
		});

		it("should handle empty graph", () => {
			const mermaid = graph.toMermaid();
			expect(mermaid).toContain("No nodes found");
		});

		it("should support LR direction", () => {
			const lr = new NodeDependencyGraph({ direction: "LR" });
			lr.addWorkflow(userApiWorkflow);
			expect(lr.toMermaid()).toContain("graph LR");
		});
	});

	describe("DOT Output", () => {
		it("should generate valid DOT for single workflow", () => {
			graph.addWorkflow(userApiWorkflow);
			const dot = graph.toDot();

			expect(dot).toContain("digraph G {");
			expect(dot).toContain("rankdir=TB");
			expect(dot).toContain("validator");
			expect(dot).toContain("}");
		});

		it("should generate DOT with clusters for multiple workflows", () => {
			graph.addWorkflows([userApiWorkflow, orderWorkflow]);
			const dot = graph.toDot();

			expect(dot).toContain("subgraph cluster_");
			expect(dot).toContain("user_api");
			expect(dot).toContain("process_order");
		});

		it("should use orange color for shared nodes", () => {
			graph.addWorkflows([userApiWorkflow, orderWorkflow]);
			const dot = graph.toDot();

			expect(dot).toContain("#FF9800");
		});

		it("should handle empty graph", () => {
			const dot = graph.toDot();
			expect(dot).toContain("No nodes found");
		});
	});

	describe("ASCII Output", () => {
		it("should generate ASCII for single workflow", () => {
			graph.addWorkflow(userApiWorkflow);
			const ascii = graph.toAscii();

			expect(ascii).toContain("Node Dependency Graph");
			expect(ascii).toContain("Nodes: 3");
			expect(ascii).toContain("validator");
			expect(ascii).toContain("db-query");
			expect(ascii).toContain("formatter");
		});

		it("should mark shared nodes with star", () => {
			graph.addWorkflows([userApiWorkflow, orderWorkflow]);
			const ascii = graph.toAscii();

			expect(ascii).toContain("★");
			expect(ascii).toContain("Shared Nodes");
		});

		it("should show orphan nodes", () => {
			graph.addWorkflow(workflowWithOrphan);
			const ascii = graph.toAscii();

			expect(ascii).toContain("Orphan Nodes");
			expect(ascii).toContain("orphan-node");
		});

		it("should handle empty graph", () => {
			const ascii = graph.toAscii();
			expect(ascii).toContain("No nodes found");
		});

		it("should show runtime info", () => {
			graph.addWorkflow(orderWorkflow);
			const ascii = graph.toAscii();

			expect(ascii).toContain("python3");
			expect(ascii).toContain("go");
		});
	});

	describe("JSON Output", () => {
		it("should generate valid JSON", () => {
			graph.addWorkflow(userApiWorkflow);
			const json = graph.toJson();
			const parsed = JSON.parse(json);

			expect(parsed.nodes).toHaveLength(3);
			expect(parsed.edges).toHaveLength(2);
			expect(parsed.stats).toBeDefined();
			expect(parsed.stats.totalNodes).toBe(3);
		});

		it("should include step references in JSON", () => {
			graph.addWorkflow(userApiWorkflow);
			const parsed = JSON.parse(graph.toJson());

			const validator = parsed.nodes.find((n: { nodeId: string }) => n.nodeId === "validator");
			expect(validator.usedInSteps).toHaveLength(1);
			expect(validator.usedInSteps[0].stepName).toBe("validate");
		});

		it("should include runtimes in JSON", () => {
			graph.addWorkflow(orderWorkflow);
			const parsed = JSON.parse(graph.toJson());

			const processor = parsed.nodes.find((n: { nodeId: string }) => n.nodeId === "order-processor");
			expect(processor.runtimes).toContain("python3");
		});
	});

	describe("Conditional Workflow Support", () => {
		it("should handle conditional flows", () => {
			graph.addWorkflow(conditionWorkflow);
			const nodeMap = graph.getNodeMap();

			expect(nodeMap.has("validator")).toBe(true);
			expect(nodeMap.has("success-handler")).toBe(true);
			expect(nodeMap.has("error-handler")).toBe(true);
			expect(nodeMap.has("finalizer")).toBe(true);
		});

		it("should create conditional edges for branches", () => {
			graph.addWorkflow(conditionWorkflow);
			const edges = graph.getEdges();
			const conditionalEdges = edges.filter((e) => e.edgeType === "conditional");

			expect(conditionalEdges.length).toBe(2);
		});
	});
});
