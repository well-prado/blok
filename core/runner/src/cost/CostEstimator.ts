/**
 * Cost Estimator for Blok Workflows
 *
 * Estimates execution costs per node and workflow based on
 * runtime type, cloud provider pricing, and optional profiling data.
 *
 * @example
 * ```typescript
 * const estimator = new CostEstimator({ provider: "aws", executionsPerMonth: 100000 });
 * const estimate = estimator.estimateWorkflow(workflowDef);
 * console.log(estimator.toTable());
 * ```
 */

import type { NodeProfile } from "../monitoring/PerformanceProfiler";
import type { StepDef, WorkflowDef } from "../visualization/WorkflowVisualizer";
import {
	type CloudProvider,
	DEFAULT_DURATIONS,
	DEFAULT_MEMORY,
	PRICING,
	type RuntimeCostCategory,
	type RuntimeCostModel,
	getRuntimeCategory,
} from "./pricing";

export interface NodeCostEstimate {
	nodeName: string;
	stepName: string;
	runtime: string;
	category: RuntimeCostCategory;
	estimatedDurationMs: number;
	estimatedMemoryMb: number;
	costPerExecution: number;
	monthlyCost: number;
}

export interface WorkflowCostEstimate {
	workflowName: string;
	nodes: NodeCostEstimate[];
	costPerExecution: number;
	monthlyCost: number;
	executionsPerMonth: number;
	provider: CloudProvider;
}

export interface CostEstimatorConfig {
	provider?: CloudProvider;
	executionsPerMonth?: number;
	customPricing?: Partial<Record<RuntimeCostCategory, Partial<RuntimeCostModel>>>;
}

export class CostEstimator {
	private config: Required<Omit<CostEstimatorConfig, "customPricing">> & {
		customPricing: CostEstimatorConfig["customPricing"];
	};
	private estimates: WorkflowCostEstimate[] = [];

	constructor(config?: CostEstimatorConfig) {
		this.config = {
			provider: config?.provider ?? "aws",
			executionsPerMonth: config?.executionsPerMonth ?? 10_000,
			customPricing: config?.customPricing,
		};
	}

	estimateWorkflow(workflow: WorkflowDef, profiles?: NodeProfile[]): WorkflowCostEstimate {
		const profileMap = new Map<string, NodeProfile>();
		if (profiles) {
			for (const p of profiles) {
				profileMap.set(p.nodeName, p);
			}
		}

		const nodes: NodeCostEstimate[] = [];

		this.walkSteps(workflow.steps, profileMap, nodes);

		const costPerExecution = nodes.reduce((sum, n) => sum + n.costPerExecution, 0);
		const monthlyCost = costPerExecution * this.config.executionsPerMonth;

		const estimate: WorkflowCostEstimate = {
			workflowName: workflow.name,
			nodes,
			costPerExecution,
			monthlyCost,
			executionsPerMonth: this.config.executionsPerMonth,
			provider: this.config.provider,
		};

		this.estimates.push(estimate);
		return estimate;
	}

	estimateNode(
		nodeName: string,
		stepName: string,
		stepType: string,
		runtime: string,
		avgDurationMs?: number,
		avgMemoryMb?: number,
	): NodeCostEstimate {
		const category = getRuntimeCategory(runtime || "nodejs", stepType);
		const costModel = this.getCostModel(category);

		const durationMs = avgDurationMs ?? DEFAULT_DURATIONS[category];
		const memoryMb = avgMemoryMb ?? DEFAULT_MEMORY[category];

		const cpuCost = durationMs * costModel.costPerMsCpu;
		const memoryCost = ((memoryMb * durationMs) / 1000) * costModel.costPerMbMemorySecond;
		const costPerExecution = costModel.baseCostPerExecution + cpuCost + memoryCost + costModel.networkCostPerCall;

		return {
			nodeName,
			stepName,
			runtime: runtime || this.inferRuntime(stepType),
			category,
			estimatedDurationMs: durationMs,
			estimatedMemoryMb: memoryMb,
			costPerExecution,
			monthlyCost: costPerExecution * this.config.executionsPerMonth,
		};
	}

	getEstimates(): WorkflowCostEstimate[] {
		return this.estimates;
	}

	toTable(): string {
		if (this.estimates.length === 0) return "[No cost estimates]";

		const lines: string[] = [];

		for (const estimate of this.estimates) {
			lines.push("");
			lines.push(
				`  Workflow: ${estimate.workflowName}  |  Provider: ${estimate.provider.toUpperCase()}  |  ${this.fmtNum(estimate.executionsPerMonth)} exec/month`,
			);
			lines.push("");

			const header = this.padColumns([
				{ val: "Node", width: 22 },
				{ val: "Runtime", width: 10 },
				{ val: "Type", width: 12 },
				{ val: "Dur(ms)", width: 10 },
				{ val: "Mem(MB)", width: 10 },
				{ val: "Per Exec", width: 12 },
				{ val: "Monthly", width: 12 },
			]);

			lines.push(`  ${header}`);
			lines.push(`  ${"─".repeat(header.length)}`);

			for (const node of estimate.nodes) {
				const row = this.padColumns([
					{ val: this.truncate(node.nodeName, 20), width: 22 },
					{ val: node.runtime, width: 10 },
					{ val: node.category, width: 12 },
					{ val: node.estimatedDurationMs.toFixed(0), width: 10 },
					{ val: node.estimatedMemoryMb.toFixed(0), width: 10 },
					{ val: this.fmtUsd(node.costPerExecution), width: 12 },
					{ val: this.fmtUsd(node.monthlyCost), width: 12 },
				]);
				lines.push(`  ${row}`);
			}

			lines.push(`  ${"─".repeat(header.length)}`);
			const totalRow = this.padColumns([
				{ val: "TOTAL", width: 22 },
				{ val: "", width: 10 },
				{ val: "", width: 12 },
				{ val: "", width: 10 },
				{ val: "", width: 10 },
				{ val: this.fmtUsd(estimate.costPerExecution), width: 12 },
				{ val: this.fmtUsd(estimate.monthlyCost), width: 12 },
			]);
			lines.push(`  ${totalRow}`);
		}

		lines.push("");
		return lines.join("\n");
	}

	toJson(): string {
		return JSON.stringify(this.estimates, null, 2);
	}

	reset(): void {
		this.estimates = [];
	}

	// -- Internal --

	private walkSteps(steps: StepDef[], profileMap: Map<string, NodeProfile>, nodes: NodeCostEstimate[]): void {
		for (const step of steps) {
			const profile = profileMap.get(step.node);
			const estimate = this.estimateNode(
				step.node,
				step.name,
				step.type || "local",
				step.runtime || "",
				profile?.avgTimeMs,
				profile?.memoryAvgMb,
			);
			nodes.push(estimate);

			if (step.conditions) {
				for (const cond of step.conditions) {
					if (cond.steps) {
						this.walkSteps(cond.steps, profileMap, nodes);
					}
				}
			}
		}
	}

	private getCostModel(category: RuntimeCostCategory): RuntimeCostModel {
		const base = PRICING[this.config.provider][category];
		const custom = this.config.customPricing?.[category];

		if (custom) {
			return { ...base, ...custom } as RuntimeCostModel;
		}

		return base;
	}

	private inferRuntime(stepType: string): string {
		if (stepType.startsWith("runtime.")) {
			return stepType.replace("runtime.", "");
		}
		return "nodejs";
	}

	private fmtUsd(amount: number): string {
		if (amount === 0) return "$0.00";
		if (amount < 0.01) return `$${amount.toFixed(6)}`;
		if (amount < 1) return `$${amount.toFixed(4)}`;
		if (amount < 1000) return `$${amount.toFixed(2)}`;
		return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	}

	private fmtNum(n: number): string {
		return n.toLocaleString("en-US");
	}

	private truncate(s: string, len: number): string {
		return s.length > len ? `${s.substring(0, len - 3)}...` : s;
	}

	private padColumns(cols: Array<{ val: string; width: number }>): string {
		return cols.map((c) => c.val + " ".repeat(Math.max(0, c.width - c.val.length))).join("");
	}
}
