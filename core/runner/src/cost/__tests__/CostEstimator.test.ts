import { beforeEach, describe, expect, it } from "vitest";
import type { WorkflowDef } from "../../visualization/WorkflowVisualizer";
import { CostEstimator } from "../CostEstimator";
import { getRuntimeCategory } from "../pricing";

// -- Fixtures --

const simpleWorkflow: WorkflowDef = {
	name: "user-api",
	version: "1.0.0",
	trigger: { http: { method: "GET", path: "/users/:id" } },
	steps: [
		{ name: "validate", node: "validator", type: "local" },
		{ name: "fetch", node: "db-query", type: "local" },
	],
	nodes: { validator: {}, "db-query": {} },
};

const multiRuntimeWorkflow: WorkflowDef = {
	name: "multi-runtime",
	version: "1.0.0",
	trigger: { http: { method: "POST", path: "/process" } },
	steps: [
		{ name: "validate", node: "validator", type: "local" },
		{ name: "analyze", node: "ml-model", type: "runtime.python3", runtime: "python3" },
		{ name: "transform", node: "transformer", type: "runtime.go", runtime: "go" },
		{ name: "cache", node: "cache-node", type: "runtime.wasm", runtime: "wasm" },
	],
	nodes: { validator: {}, "ml-model": {}, transformer: {}, "cache-node": {} },
};

const conditionWorkflow: WorkflowDef = {
	name: "conditional",
	version: "1.0.0",
	trigger: { http: { method: "POST", path: "/check" } },
	steps: [
		{
			name: "check",
			node: "validator",
			type: "local",
			conditions: [
				{
					type: "if",
					expression: "ctx.valid",
					steps: [{ name: "success", node: "handler", type: "local" }],
				},
			],
		},
	],
	nodes: { validator: {}, handler: {} },
};

// -- Tests --

describe("CostEstimator", () => {
	let estimator: CostEstimator;

	beforeEach(() => {
		estimator = new CostEstimator({ provider: "aws", executionsPerMonth: 10_000 });
	});

	describe("getRuntimeCategory", () => {
		it("should categorize nodejs as in-process", () => {
			expect(getRuntimeCategory("nodejs")).toBe("in-process");
		});

		it("should categorize bun as in-process", () => {
			expect(getRuntimeCategory("bun")).toBe("in-process");
		});

		it("should categorize python3 as grpc", () => {
			expect(getRuntimeCategory("python3")).toBe("grpc");
		});

		it("should categorize go as docker", () => {
			expect(getRuntimeCategory("go")).toBe("docker");
		});

		it("should categorize java as docker", () => {
			expect(getRuntimeCategory("java")).toBe("docker");
		});

		it("should categorize rust as docker", () => {
			expect(getRuntimeCategory("rust")).toBe("docker");
		});

		it("should categorize wasm as wasm", () => {
			expect(getRuntimeCategory("wasm")).toBe("wasm");
		});

		it("should use stepType for local nodes", () => {
			expect(getRuntimeCategory("nodejs", "local")).toBe("in-process");
		});

		it("should use stepType for module nodes", () => {
			expect(getRuntimeCategory("nodejs", "module")).toBe("in-process");
		});
	});

	describe("Workflow Estimation", () => {
		it("should estimate a simple workflow", () => {
			const estimate = estimator.estimateWorkflow(simpleWorkflow);

			expect(estimate.workflowName).toBe("user-api");
			expect(estimate.provider).toBe("aws");
			expect(estimate.executionsPerMonth).toBe(10_000);
			expect(estimate.nodes.length).toBe(2);
			expect(estimate.costPerExecution).toBeGreaterThan(0);
			expect(estimate.monthlyCost).toBeGreaterThan(0);
		});

		it("should estimate multi-runtime workflow with different categories", () => {
			const estimate = estimator.estimateWorkflow(multiRuntimeWorkflow);

			expect(estimate.nodes.length).toBe(4);

			const validator = estimate.nodes.find((n) => n.nodeName === "validator")!;
			expect(validator.category).toBe("in-process");

			const mlModel = estimate.nodes.find((n) => n.nodeName === "ml-model")!;
			expect(mlModel.category).toBe("grpc");

			const transformer = estimate.nodes.find((n) => n.nodeName === "transformer")!;
			expect(transformer.category).toBe("docker");

			const cache = estimate.nodes.find((n) => n.nodeName === "cache-node")!;
			expect(cache.category).toBe("wasm");
		});

		it("should make docker more expensive than in-process", () => {
			const estimate = estimator.estimateWorkflow(multiRuntimeWorkflow);

			const inProcess = estimate.nodes.find((n) => n.category === "in-process")!;
			const docker = estimate.nodes.find((n) => n.category === "docker")!;

			// Docker should cost more per execution due to container overhead and higher resource usage
			expect(docker.costPerExecution).toBeGreaterThan(inProcess.costPerExecution);
		});

		it("should handle conditional workflows", () => {
			const estimate = estimator.estimateWorkflow(conditionWorkflow);

			// Should include both the main step and conditional step
			expect(estimate.nodes.length).toBe(2);
		});

		it("should compute monthly cost correctly", () => {
			const estimate = estimator.estimateWorkflow(simpleWorkflow);
			expect(estimate.monthlyCost).toBeCloseTo(estimate.costPerExecution * 10_000);
		});
	});

	describe("Node Estimation", () => {
		it("should estimate a single node", () => {
			const estimate = estimator.estimateNode("test", "test-step", "local", "nodejs");

			expect(estimate.nodeName).toBe("test");
			expect(estimate.category).toBe("in-process");
			expect(estimate.costPerExecution).toBeGreaterThanOrEqual(0);
		});

		it("should use provided duration and memory", () => {
			const estimate = estimator.estimateNode("test", "step", "local", "nodejs", 50, 128);

			expect(estimate.estimatedDurationMs).toBe(50);
			expect(estimate.estimatedMemoryMb).toBe(128);
		});

		it("should use defaults when no profiling data", () => {
			const estimate = estimator.estimateNode("test", "step", "local", "nodejs");

			expect(estimate.estimatedDurationMs).toBeGreaterThan(0);
			expect(estimate.estimatedMemoryMb).toBeGreaterThan(0);
		});

		it("should infer runtime from step type", () => {
			const estimate = estimator.estimateNode("test", "step", "runtime.python3", "");

			expect(estimate.runtime).toBe("python3");
		});
	});

	describe("Provider Variations", () => {
		it("should support AWS pricing", () => {
			const aws = new CostEstimator({ provider: "aws", executionsPerMonth: 1_000_000 });
			const estimate = aws.estimateWorkflow(simpleWorkflow);
			expect(estimate.monthlyCost).toBeGreaterThan(0);
		});

		it("should support GCP pricing", () => {
			const gcp = new CostEstimator({ provider: "gcp", executionsPerMonth: 1_000_000 });
			const estimate = gcp.estimateWorkflow(simpleWorkflow);
			expect(estimate.monthlyCost).toBeGreaterThan(0);
		});

		it("should support Azure pricing", () => {
			const azure = new CostEstimator({ provider: "azure", executionsPerMonth: 1_000_000 });
			const estimate = azure.estimateWorkflow(simpleWorkflow);
			expect(estimate.monthlyCost).toBeGreaterThan(0);
		});

		it("should return zero cost for local provider", () => {
			const local = new CostEstimator({ provider: "local" });
			const estimate = local.estimateWorkflow(simpleWorkflow);
			expect(estimate.costPerExecution).toBe(0);
			expect(estimate.monthlyCost).toBe(0);
		});
	});

	describe("With Profiling Data", () => {
		it("should use profiling data for more accurate estimates", () => {
			const profiles = [
				{ nodeName: "validator", avgTimeMs: 5, memoryAvgMb: 32 },
				{ nodeName: "db-query", avgTimeMs: 150, memoryAvgMb: 64 },
			];

			const estimate = estimator.estimateWorkflow(simpleWorkflow, profiles as any);

			const validator = estimate.nodes.find((n) => n.nodeName === "validator")!;
			const dbQuery = estimate.nodes.find((n) => n.nodeName === "db-query")!;

			expect(validator.estimatedDurationMs).toBe(5);
			expect(dbQuery.estimatedDurationMs).toBe(150);
			expect(dbQuery.costPerExecution).toBeGreaterThan(validator.costPerExecution);
		});
	});

	describe("Custom Pricing", () => {
		it("should support custom pricing overrides", () => {
			const custom = new CostEstimator({
				provider: "aws",
				customPricing: {
					"in-process": {
						baseCostPerExecution: 0.001,
					},
				},
			});

			const estimate = custom.estimateWorkflow(simpleWorkflow);
			const node = estimate.nodes[0];
			expect(node.costPerExecution).toBeGreaterThanOrEqual(0.001);
		});
	});

	describe("Table Output", () => {
		it("should generate a readable table", () => {
			estimator.estimateWorkflow(multiRuntimeWorkflow);
			const table = estimator.toTable();

			expect(table).toContain("Workflow: multi-runtime");
			expect(table).toContain("Provider: AWS");
			expect(table).toContain("Node");
			expect(table).toContain("Runtime");
			expect(table).toContain("Per Exec");
			expect(table).toContain("Monthly");
			expect(table).toContain("TOTAL");
			expect(table).toContain("$");
		});

		it("should handle empty estimator", () => {
			const table = estimator.toTable();
			expect(table).toContain("No cost estimates");
		});
	});

	describe("JSON Output", () => {
		it("should generate valid JSON", () => {
			estimator.estimateWorkflow(simpleWorkflow);
			const json = estimator.toJson();
			const parsed = JSON.parse(json);

			expect(parsed).toBeInstanceOf(Array);
			expect(parsed.length).toBe(1);
			expect(parsed[0].workflowName).toBe("user-api");
			expect(parsed[0].nodes).toBeInstanceOf(Array);
		});
	});

	describe("Reset", () => {
		it("should clear all estimates", () => {
			estimator.estimateWorkflow(simpleWorkflow);
			expect(estimator.getEstimates().length).toBe(1);

			estimator.reset();
			expect(estimator.getEstimates().length).toBe(0);
		});
	});
});
