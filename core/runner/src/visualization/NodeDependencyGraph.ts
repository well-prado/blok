/**
 * Node Dependency Graph for Blok Workflows
 *
 * Analyzes cross-workflow node dependencies and generates
 * dependency graphs showing how nodes relate across workflows.
 *
 * @example
 * ```typescript
 * const graph = new NodeDependencyGraph();
 * graph.addWorkflows([workflow1, workflow2]);
 * console.log(graph.toAscii());
 * console.log(graph.toMermaid());
 * ```
 */

import type { StepDef, WorkflowDef } from "./WorkflowVisualizer";

export interface StepRef {
	workflowName: string;
	stepName: string;
	type?: string;
	runtime?: string;
}

export interface DependencyNode {
	nodeId: string;
	usedInWorkflows: string[];
	usedInSteps: StepRef[];
	types: Set<string>;
	runtimes: Set<string>;
}

export interface DependencyEdge {
	from: string;
	to: string;
	workflow: string;
	edgeType: "sequential" | "conditional";
}

export interface DependencyGraphConfig {
	direction?: "TB" | "LR" | "BT" | "RL";
	showWorkflowBoundaries?: boolean;
	filterWorkflow?: string;
	filterNode?: string;
	showOrphanNodes?: boolean;
}

export interface DependencyStats {
	totalNodes: number;
	totalEdges: number;
	totalWorkflows: number;
	sharedNodes: number;
	orphanNodes: number;
	mostUsedNode: { nodeId: string; count: number } | null;
}

export class NodeDependencyGraph {
	private config: Required<DependencyGraphConfig>;
	private workflows: WorkflowDef[] = [];

	constructor(config?: DependencyGraphConfig) {
		this.config = {
			direction: config?.direction ?? "TB",
			showWorkflowBoundaries: config?.showWorkflowBoundaries ?? true,
			filterWorkflow: config?.filterWorkflow ?? "",
			filterNode: config?.filterNode ?? "",
			showOrphanNodes: config?.showOrphanNodes ?? true,
		};
	}

	addWorkflow(workflow: WorkflowDef): void {
		this.workflows.push(workflow);
	}

	addWorkflows(workflows: WorkflowDef[]): void {
		this.workflows.push(...workflows);
	}

	getNodeMap(): Map<string, DependencyNode> {
		const nodeMap = new Map<string, DependencyNode>();
		const filtered = this.getFilteredWorkflows();

		for (const workflow of filtered) {
			// Register all nodes defined in the workflow
			for (const nodeId of Object.keys(workflow.nodes)) {
				if (!nodeMap.has(nodeId)) {
					nodeMap.set(nodeId, {
						nodeId,
						usedInWorkflows: [],
						usedInSteps: [],
						types: new Set(),
						runtimes: new Set(),
					});
				}
			}

			// Walk steps and record usage
			this.walkSteps(workflow.steps, workflow.name, nodeMap);
		}

		// Apply node filter
		if (this.config.filterNode) {
			const target = this.config.filterNode;
			const targetNode = nodeMap.get(target);
			if (!targetNode) return new Map();

			// Keep only target and its neighbors
			const edges = this.getEdges();
			const neighbors = new Set<string>([target]);
			for (const edge of edges) {
				if (edge.from === target) neighbors.add(edge.to);
				if (edge.to === target) neighbors.add(edge.from);
			}

			const filtered = new Map<string, DependencyNode>();
			for (const [id, node] of nodeMap) {
				if (neighbors.has(id)) {
					filtered.set(id, node);
				}
			}
			return filtered;
		}

		return nodeMap;
	}

	getEdges(): DependencyEdge[] {
		const edges: DependencyEdge[] = [];
		const filtered = this.getFilteredWorkflows();

		for (const workflow of filtered) {
			this.collectEdges(workflow.steps, workflow.name, edges);
		}

		if (this.config.filterNode) {
			const target = this.config.filterNode;
			return edges.filter((e) => e.from === target || e.to === target);
		}

		return edges;
	}

	getSharedNodes(): DependencyNode[] {
		const nodeMap = this.getNodeMap();
		return Array.from(nodeMap.values()).filter((n) => n.usedInWorkflows.length > 1);
	}

	getOrphanNodes(): string[] {
		const nodeMap = this.getNodeMap();
		return Array.from(nodeMap.values())
			.filter((n) => n.usedInSteps.length === 0)
			.map((n) => n.nodeId);
	}

	getWorkflowsForNode(nodeId: string): string[] {
		const nodeMap = this.getNodeMap();
		const node = nodeMap.get(nodeId);
		return node ? [...new Set(node.usedInWorkflows)] : [];
	}

	getStats(): DependencyStats {
		const nodeMap = this.getNodeMap();
		const edges = this.getEdges();
		const shared = this.getSharedNodes();
		const orphans = this.getOrphanNodes();

		let mostUsed: { nodeId: string; count: number } | null = null;
		for (const node of nodeMap.values()) {
			if (!mostUsed || node.usedInSteps.length > mostUsed.count) {
				mostUsed = { nodeId: node.nodeId, count: node.usedInSteps.length };
			}
		}

		return {
			totalNodes: nodeMap.size,
			totalEdges: edges.length,
			totalWorkflows: this.getFilteredWorkflows().length,
			sharedNodes: shared.length,
			orphanNodes: orphans.length,
			mostUsedNode: mostUsed,
		};
	}

	toMermaid(): string {
		const nodeMap = this.getNodeMap();
		const edges = this.getEdges();

		if (nodeMap.size === 0) {
			return `graph ${this.config.direction}\n  empty[No nodes found]`;
		}

		const lines: string[] = [];
		lines.push(`graph ${this.config.direction}`);

		if (this.config.showWorkflowBoundaries) {
			const workflowNodes = this.groupNodesByWorkflow(nodeMap);

			for (const [wfName, nodeIds] of workflowNodes) {
				lines.push(`  subgraph ${this.sanitizeId(wfName)}["${wfName}"]`);
				for (const nodeId of nodeIds) {
					const node = nodeMap.get(nodeId);
					if (!node) continue;
					const label = this.nodeLabel(node);
					const isShared = node.usedInWorkflows.length > 1;
					const cls = isShared ? ":::shared" : ":::node";
					lines.push(`    ${this.sanitizeId(nodeId)}["${label}"]${cls}`);
				}
				lines.push("  end");
			}

			// Shared nodes outside any subgraph
			const shared = this.getSharedNodes();
			if (shared.length > 0) {
				lines.push(`  subgraph shared["Shared Nodes"]`);
				for (const node of shared) {
					const label = `${node.nodeId}\\n(${node.usedInWorkflows.length} workflows)`;
					lines.push(`    shared_${this.sanitizeId(node.nodeId)}["${label}"]:::shared`);
				}
				lines.push("  end");
			}
		} else {
			for (const [nodeId, node] of nodeMap) {
				const label = this.nodeLabel(node);
				const isShared = node.usedInWorkflows.length > 1;
				const cls = isShared ? ":::shared" : ":::node";
				lines.push(`  ${this.sanitizeId(nodeId)}["${label}"]${cls}`);
			}
		}

		// Edges
		for (const edge of edges) {
			const from = this.sanitizeId(edge.from);
			const to = this.sanitizeId(edge.to);
			const arrow = edge.edgeType === "conditional" ? "-.->" : "-->";
			lines.push(`  ${from} ${arrow} ${to}`);
		}

		// Styling
		lines.push("");
		lines.push("  classDef node fill:#2196F3,stroke:#1565C0,color:#fff");
		lines.push("  classDef shared fill:#FF9800,stroke:#E65100,color:#fff");
		lines.push("  classDef orphan fill:#9E9E9E,stroke:#616161,color:#fff");

		return lines.join("\n");
	}

	toDot(): string {
		const nodeMap = this.getNodeMap();
		const edges = this.getEdges();

		if (nodeMap.size === 0) {
			return 'digraph G {\n  empty [label="No nodes found"];\n}';
		}

		const lines: string[] = [];
		lines.push("digraph G {");
		lines.push(`  rankdir=${this.config.direction};`);
		lines.push('  node [fontname="Helvetica", fontsize=12];');
		lines.push('  edge [fontname="Helvetica", fontsize=10];');

		if (this.config.showWorkflowBoundaries) {
			const workflowNodes = this.groupNodesByWorkflow(nodeMap);

			for (const [wfName, nodeIds] of workflowNodes) {
				lines.push(`  subgraph cluster_${this.sanitizeId(wfName)} {`);
				lines.push(`    label="${wfName}";`);
				lines.push("    style=dashed;");
				for (const nodeId of nodeIds) {
					const node = nodeMap.get(nodeId);
					if (!node) continue;
					const label = this.nodeLabel(node).replace(/\\n/g, "\\n");
					const color = node.usedInWorkflows.length > 1 ? "#FF9800" : "#2196F3";
					lines.push(
						`    ${this.sanitizeId(nodeId)} [label="${label}", shape=box, style="filled,rounded", fillcolor="${color}", fontcolor=white];`,
					);
				}
				lines.push("  }");
			}
		} else {
			for (const [nodeId, node] of nodeMap) {
				const label = this.nodeLabel(node).replace(/\\n/g, "\\n");
				const color = node.usedInWorkflows.length > 1 ? "#FF9800" : "#2196F3";
				lines.push(
					`  ${this.sanitizeId(nodeId)} [label="${label}", shape=box, style="filled,rounded", fillcolor="${color}", fontcolor=white];`,
				);
			}
		}

		for (const edge of edges) {
			const from = this.sanitizeId(edge.from);
			const to = this.sanitizeId(edge.to);
			const attrs = edge.edgeType === "conditional" ? " [style=dashed]" : "";
			lines.push(`  ${from} -> ${to}${attrs};`);
		}

		lines.push("}");
		return lines.join("\n");
	}

	toAscii(): string {
		const nodeMap = this.getNodeMap();
		const edges = this.getEdges();
		const stats = this.getStats();

		if (nodeMap.size === 0) {
			return "[No nodes found]";
		}

		const lines: string[] = [];
		const width = 60;

		lines.push(`╔${"═".repeat(width)}╗`);
		lines.push(`║ ${this.padRight("Node Dependency Graph", width - 1)}║`);
		lines.push(`╠${"═".repeat(width)}╣`);
		lines.push(
			`║ ${this.padRight(`Nodes: ${stats.totalNodes}  Edges: ${stats.totalEdges}  Workflows: ${stats.totalWorkflows}`, width - 1)}║`,
		);
		lines.push(`║ ${this.padRight(`Shared: ${stats.sharedNodes}  Orphans: ${stats.orphanNodes}`, width - 1)}║`);
		lines.push(`╠${"═".repeat(width)}╣`);

		// Group by workflow
		const workflowNodes = this.groupNodesByWorkflow(nodeMap);

		for (const [wfName, nodeIds] of workflowNodes) {
			lines.push(`║ ${this.padRight(`┌─ ${wfName}`, width - 1)}║`);

			const wfEdges = edges.filter((e) => e.workflow === wfName);
			const adjacency = new Map<string, string[]>();
			for (const edge of wfEdges) {
				if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
				const fromList = adjacency.get(edge.from);
				if (fromList) fromList.push(edge.to);
			}

			for (let i = 0; i < nodeIds.length; i++) {
				const nodeId = nodeIds[i];
				const node = nodeMap.get(nodeId);
				if (!node) continue;
				const shared = node.usedInWorkflows.length > 1 ? " ★" : "";
				const runtime = node.runtimes.size > 0 ? ` [${Array.from(node.runtimes).join(",")}]` : "";
				const label = `${nodeId}${runtime}${shared}`;
				const truncated = label.length > width - 8 ? `${label.substring(0, width - 11)}...` : label;
				lines.push(`║ ${this.padRight(`│  ▪ ${truncated}`, width - 1)}║`);

				const targets = adjacency.get(nodeId) || [];
				if (targets.length > 0 && i < nodeIds.length - 1) {
					lines.push(`║ ${this.padRight("│  │", width - 1)}║`);
					lines.push(`║ ${this.padRight("│  ▼", width - 1)}║`);
				}
			}

			lines.push(`║ ${this.padRight("└──", width - 1)}║`);
		}

		// Shared nodes summary
		const shared = this.getSharedNodes();
		if (shared.length > 0) {
			lines.push(`╠${"═".repeat(width)}╣`);
			lines.push(`║ ${this.padRight("★ Shared Nodes:", width - 1)}║`);
			for (const node of shared) {
				const wfs = [...new Set(node.usedInWorkflows)].join(", ");
				const label = `  ${node.nodeId} → ${wfs}`;
				const truncated = label.length > width - 4 ? `${label.substring(0, width - 7)}...` : label;
				lines.push(`║ ${this.padRight(truncated, width - 1)}║`);
			}
		}

		// Orphan nodes
		const orphans = this.getOrphanNodes();
		if (orphans.length > 0 && this.config.showOrphanNodes) {
			lines.push(`╠${"═".repeat(width)}╣`);
			lines.push(`║ ${this.padRight("⚠ Orphan Nodes (defined but unused):", width - 1)}║`);
			for (const nodeId of orphans) {
				lines.push(`║ ${this.padRight(`  ${nodeId}`, width - 1)}║`);
			}
		}

		lines.push(`╚${"═".repeat(width)}╝`);

		return lines.join("\n");
	}

	toJson(): string {
		const nodeMap = this.getNodeMap();
		const edges = this.getEdges();
		const stats = this.getStats();

		const nodes = Array.from(nodeMap.values()).map((n) => ({
			nodeId: n.nodeId,
			usedInWorkflows: [...new Set(n.usedInWorkflows)],
			usedInSteps: n.usedInSteps,
			types: Array.from(n.types),
			runtimes: Array.from(n.runtimes),
		}));

		return JSON.stringify({ nodes, edges, stats }, null, 2);
	}

	// -- Internal helpers --

	private getFilteredWorkflows(): WorkflowDef[] {
		if (this.config.filterWorkflow) {
			return this.workflows.filter((w) => w.name === this.config.filterWorkflow);
		}
		return this.workflows;
	}

	private walkSteps(steps: StepDef[], workflowName: string, nodeMap: Map<string, DependencyNode>): void {
		for (const step of steps) {
			const nodeId = step.node;

			if (!nodeMap.has(nodeId)) {
				nodeMap.set(nodeId, {
					nodeId,
					usedInWorkflows: [],
					usedInSteps: [],
					types: new Set(),
					runtimes: new Set(),
				});
			}

			const node = nodeMap.get(nodeId);
			if (!node) return;
			node.usedInWorkflows.push(workflowName);
			node.usedInSteps.push({
				workflowName,
				stepName: step.name,
				type: step.type,
				runtime: step.runtime,
			});

			if (step.type) node.types.add(step.type);
			if (step.runtime) node.runtimes.add(step.runtime);

			// Walk conditions recursively
			if (step.conditions) {
				for (const cond of step.conditions) {
					if (cond.steps) {
						this.walkSteps(cond.steps, workflowName, nodeMap);
					}
				}
			}
		}
	}

	private collectEdges(steps: StepDef[], workflowName: string, edges: DependencyEdge[]): void {
		for (let i = 0; i < steps.length - 1; i++) {
			edges.push({
				from: steps[i].node,
				to: steps[i + 1].node,
				workflow: workflowName,
				edgeType: "sequential",
			});
		}

		for (const step of steps) {
			if (step.conditions) {
				for (const cond of step.conditions) {
					if (cond.steps && cond.steps.length > 0) {
						edges.push({
							from: step.node,
							to: cond.steps[0].node,
							workflow: workflowName,
							edgeType: "conditional",
						});
						this.collectEdges(cond.steps, workflowName, edges);
					}
				}
			}
		}
	}

	private groupNodesByWorkflow(nodeMap: Map<string, DependencyNode>): Map<string, string[]> {
		const groups = new Map<string, Set<string>>();

		for (const [nodeId, node] of nodeMap) {
			const workflows = [...new Set(node.usedInWorkflows)];
			if (workflows.length === 0) {
				// Orphan node - put in first workflow or standalone
				const wfName = this.workflows[0]?.name ?? "orphans";
				if (!groups.has(wfName)) groups.set(wfName, new Set());
				groups.get(wfName)?.add(nodeId);
			} else {
				for (const wf of workflows) {
					if (!groups.has(wf)) groups.set(wf, new Set());
					groups.get(wf)?.add(nodeId);
				}
			}
		}

		// Convert sets to arrays preserving step order
		const result = new Map<string, string[]>();
		for (const [wf, ids] of groups) {
			result.set(wf, Array.from(ids));
		}
		return result;
	}

	private nodeLabel(node: DependencyNode): string {
		let label = node.nodeId;
		if (node.runtimes.size > 0) {
			label += `\\n[${Array.from(node.runtimes).join(", ")}]`;
		} else if (node.types.size > 0) {
			label += `\\n[${Array.from(node.types).join(", ")}]`;
		}
		return label;
	}

	private sanitizeId(name: string): string {
		return name.replace(/[^a-zA-Z0-9]/g, "_");
	}

	private padRight(str: string, length: number): string {
		return str + " ".repeat(Math.max(0, length - str.length));
	}
}
