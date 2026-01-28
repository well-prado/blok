/**
 * Workflow Visualizer for Blok Workflows
 *
 * Generates visual representations of workflow DAGs in multiple formats:
 * - Mermaid (for markdown, GitHub, documentation)
 * - DOT/Graphviz (for SVG/PNG rendering)
 * - ASCII (for terminal output)
 *
 * @example
 * ```typescript
 * const viz = new WorkflowVisualizer();
 * viz.addWorkflow({
 *   name: "user-api",
 *   version: "1.0.0",
 *   trigger: { http: { method: "GET", path: "/users/:id" } },
 *   steps: [
 *     { name: "validate", node: "validator", type: "local" },
 *     { name: "fetch-user", node: "db-query", type: "local" },
 *     { name: "format", node: "formatter", type: "local" },
 *   ],
 *   nodes: { validator: {}, "db-query": {}, formatter: {} },
 * });
 *
 * console.log(viz.toMermaid());
 * console.log(viz.toDot());
 * ```
 */

export interface VisualizerConfig {
	/** Direction of the graph: TB (top-bottom), LR (left-right), BT, RL */
	direction?: "TB" | "LR" | "BT" | "RL";
	/** Include trigger info in the graph */
	showTrigger?: boolean;
	/** Include node types/runtime labels */
	showTypes?: boolean;
	/** Include condition details */
	showConditions?: boolean;
	/** Theme for the visualization */
	theme?: "default" | "dark" | "forest" | "neutral";
	/** Title for multi-workflow graphs */
	title?: string;
}

export interface WorkflowDef {
	name: string;
	version: string;
	description?: string;
	trigger: {
		http?: { method: string; path: string };
		grpc?: { service: string; method: string };
		cron?: { schedule: string };
		queue?: { provider: string; topic: string };
		pubsub?: { provider: string; topic: string };
		webhook?: { source: string; events: string[] };
		websocket?: { path?: string };
		sse?: { path?: string };
		worker?: { queue?: string };
		manual?: Record<string, unknown>;
		[key: string]: unknown;
	};
	steps: StepDef[];
	nodes: Record<string, NodeDef>;
}

export interface StepDef {
	name: string;
	node: string;
	type?: string;
	runtime?: string;
	conditions?: ConditionDef[];
}

export interface ConditionDef {
	type: "if" | "else";
	expression?: string;
	steps?: StepDef[];
}

export interface NodeDef {
	[key: string]: unknown;
}

interface GraphNode {
	id: string;
	label: string;
	type: "trigger" | "step" | "condition" | "end";
	metadata?: Record<string, string>;
}

interface GraphEdge {
	from: string;
	to: string;
	label?: string;
	style?: "solid" | "dashed" | "dotted";
}

export class WorkflowVisualizer {
	private config: Required<VisualizerConfig>;
	private workflows: WorkflowDef[] = [];

	constructor(config?: VisualizerConfig) {
		this.config = {
			direction: config?.direction ?? "TB",
			showTrigger: config?.showTrigger ?? true,
			showTypes: config?.showTypes ?? true,
			showConditions: config?.showConditions ?? true,
			theme: config?.theme ?? "default",
			title: config?.title ?? "",
		};
	}

	addWorkflow(workflow: WorkflowDef): void {
		this.workflows.push(workflow);
	}

	addWorkflows(workflows: WorkflowDef[]): void {
		this.workflows.push(...workflows);
	}

	/**
	 * Generate Mermaid diagram syntax
	 */
	toMermaid(): string {
		if (this.workflows.length === 0) {
			return `graph ${this.config.direction}\n  empty[No workflows]`;
		}

		const lines: string[] = [];

		if (this.config.theme !== "default") {
			lines.push(`%%{init: {'theme': '${this.config.theme}'}}%%`);
		}

		lines.push(`graph ${this.config.direction}`);

		if (this.config.title) {
			lines.push(`  %% ${this.config.title}`);
		}

		for (const workflow of this.workflows) {
			const { nodes, edges } = this.buildGraph(workflow);
			const prefix = this.workflows.length > 1 ? `${this.sanitizeId(workflow.name)}_` : "";

			if (this.workflows.length > 1) {
				lines.push(`  subgraph ${this.sanitizeId(workflow.name)}["${workflow.name} v${workflow.version}"]`);
			}

			for (const node of nodes) {
				const indent = this.workflows.length > 1 ? "    " : "  ";
				lines.push(`${indent}${this.mermaidNode(node, prefix)}`);
			}

			for (const edge of edges) {
				const indent = this.workflows.length > 1 ? "    " : "  ";
				lines.push(`${indent}${this.mermaidEdge(edge, prefix)}`);
			}

			if (this.workflows.length > 1) {
				lines.push("  end");
			}
		}

		// Add styling
		lines.push("");
		lines.push("  classDef trigger fill:#4CAF50,stroke:#2E7D32,color:#fff");
		lines.push("  classDef step fill:#2196F3,stroke:#1565C0,color:#fff");
		lines.push("  classDef condition fill:#FF9800,stroke:#E65100,color:#fff");
		lines.push("  classDef endNode fill:#9E9E9E,stroke:#616161,color:#fff");

		return lines.join("\n");
	}

	/**
	 * Generate DOT/Graphviz syntax
	 */
	toDot(): string {
		if (this.workflows.length === 0) {
			return 'digraph G {\n  empty [label="No workflows"];\n}';
		}

		const lines: string[] = [];
		lines.push("digraph G {");
		lines.push(`  rankdir=${this.config.direction};`);
		lines.push('  node [fontname="Helvetica", fontsize=12];');
		lines.push('  edge [fontname="Helvetica", fontsize=10];');

		if (this.config.title) {
			lines.push(`  labelloc="t";`);
			lines.push(`  label="${this.config.title}";`);
		}

		for (const workflow of this.workflows) {
			const { nodes, edges } = this.buildGraph(workflow);
			const prefix = this.workflows.length > 1 ? `${this.sanitizeId(workflow.name)}_` : "";

			if (this.workflows.length > 1) {
				lines.push(`  subgraph cluster_${this.sanitizeId(workflow.name)} {`);
				lines.push(`    label="${workflow.name} v${workflow.version}";`);
				lines.push('    style=dashed;');
			}

			for (const node of nodes) {
				const indent = this.workflows.length > 1 ? "    " : "  ";
				lines.push(`${indent}${this.dotNode(node, prefix)}`);
			}

			for (const edge of edges) {
				const indent = this.workflows.length > 1 ? "    " : "  ";
				lines.push(`${indent}${this.dotEdge(edge, prefix)}`);
			}

			if (this.workflows.length > 1) {
				lines.push("  }");
			}
		}

		lines.push("}");
		return lines.join("\n");
	}

	/**
	 * Generate ASCII art representation for terminal output
	 */
	toAscii(): string {
		if (this.workflows.length === 0) {
			return "[No workflows]";
		}

		const result: string[] = [];

		for (const workflow of this.workflows) {
			const { nodes, edges } = this.buildGraph(workflow);

			result.push(`╔${"═".repeat(50)}╗`);
			result.push(`║ ${this.padRight(`${workflow.name} v${workflow.version}`, 49)}║`);
			result.push(`╠${"═".repeat(50)}╣`);

			// Build adjacency for sequential traversal
			const adjacency = new Map<string, string[]>();
			for (const edge of edges) {
				if (!adjacency.has(edge.from)) {
					adjacency.set(edge.from, []);
				}
				adjacency.get(edge.from)!.push(edge.to);
			}

			// Walk graph from first node
			const visited = new Set<string>();
			const queue = nodes.length > 0 ? [nodes[0].id] : [];

			while (queue.length > 0) {
				const nodeId = queue.shift() as string;
				if (visited.has(nodeId)) continue;
				visited.add(nodeId);

				const node = nodes.find((n) => n.id === nodeId);
				if (!node) continue;

				const icon = this.asciiIcon(node.type);
				const label = node.label.length > 44 ? node.label.substring(0, 41) + "..." : node.label;
				result.push(`║  ${icon} ${this.padRight(label, 46)}║`);

				const targets = adjacency.get(nodeId) || [];
				if (targets.length > 0) {
					if (targets.length === 1) {
						result.push(`║  │                                               ║`);
						result.push(`║  ▼                                               ║`);
					} else {
						result.push(`║  ├──┬──${this.padRight("", 42)}║`);
						for (let i = 0; i < targets.length; i++) {
							const connector = i === targets.length - 1 ? "└" : "├";
							result.push(`║  │  ${connector}──▶ ...                                 ║`);
						}
					}
				}

				for (const t of targets) {
					if (!visited.has(t)) {
						queue.push(t);
					}
				}
			}

			result.push(`╚${"═".repeat(50)}╝`);

			if (this.workflows.indexOf(workflow) < this.workflows.length - 1) {
				result.push("");
			}
		}

		return result.join("\n");
	}

	/**
	 * Generate a summary of all workflows
	 */
	getSummary(): WorkflowSummary[] {
		return this.workflows.map((w) => {
			const triggerType = this.getTriggerType(w.trigger);
			const triggerDetail = this.getTriggerDetail(w.trigger);
			const stepCount = this.countSteps(w.steps);
			const nodeCount = Object.keys(w.nodes).length;
			const hasConditions = w.steps.some((s) => s.conditions && s.conditions.length > 0);
			const runtimes = new Set<string>();
			for (const step of w.steps) {
				if (step.runtime) runtimes.add(step.runtime);
				if (step.type?.startsWith("runtime.")) runtimes.add(step.type.replace("runtime.", ""));
			}

			return {
				name: w.name,
				version: w.version,
				description: w.description,
				triggerType,
				triggerDetail,
				stepCount,
				nodeCount,
				hasConditions,
				runtimes: Array.from(runtimes),
			};
		});
	}

	// -- Internal graph construction --

	private buildGraph(workflow: WorkflowDef): { nodes: GraphNode[]; edges: GraphEdge[] } {
		const nodes: GraphNode[] = [];
		const edges: GraphEdge[] = [];

		// Trigger node
		if (this.config.showTrigger) {
			const triggerType = this.getTriggerType(workflow.trigger);
			const triggerDetail = this.getTriggerDetail(workflow.trigger);
			nodes.push({
				id: "trigger",
				label: triggerDetail,
				type: "trigger",
				metadata: { triggerType },
			});
		}

		// Steps
		let prevId: string | null = this.config.showTrigger ? "trigger" : null;

		for (const step of workflow.steps) {
			const stepId = this.sanitizeId(step.name);
			let label = step.name;

			if (this.config.showTypes && step.type) {
				label += `\\n[${step.type}${step.runtime ? ` / ${step.runtime}` : ""}]`;
			}

			nodes.push({
				id: stepId,
				label,
				type: "step",
				metadata: {
					node: step.node,
					...(step.type ? { type: step.type } : {}),
					...(step.runtime ? { runtime: step.runtime } : {}),
				},
			});

			if (prevId) {
				edges.push({ from: prevId, to: stepId });
			}

			// Handle conditions
			if (this.config.showConditions && step.conditions && step.conditions.length > 0) {
				const condId = `cond_${stepId}`;
				nodes.push({
					id: condId,
					label: "condition",
					type: "condition",
				});
				edges.push({ from: stepId, to: condId, style: "dashed" });

				for (const cond of step.conditions) {
					if (cond.steps && cond.steps.length > 0) {
						const branchLabel = cond.type === "if" ? (cond.expression || "true") : "else";

						let condPrevId = condId;
						for (const subStep of cond.steps) {
							const subStepId = `${condId}_${this.sanitizeId(subStep.name)}`;
							let subLabel = subStep.name;
							if (this.config.showTypes && subStep.type) {
								subLabel += `\\n[${subStep.type}]`;
							}

							nodes.push({
								id: subStepId,
								label: subLabel,
								type: "step",
								metadata: { node: subStep.node },
							});

							edges.push({
								from: condPrevId,
								to: subStepId,
								label: condPrevId === condId ? branchLabel : undefined,
								style: "dashed",
							});
							condPrevId = subStepId;
						}
					}
				}

				// Skip setting prevId to condId — main flow continues from step
			}

			prevId = stepId;
		}

		// End node
		if (prevId) {
			nodes.push({ id: "end_node", label: "End", type: "end" });
			edges.push({ from: prevId, to: "end_node" });
		}

		return { nodes, edges };
	}

	private getTriggerType(trigger: WorkflowDef["trigger"]): string {
		if (trigger.http) return "http";
		if (trigger.grpc) return "grpc";
		if (trigger.cron) return "cron";
		if (trigger.queue) return "queue";
		if (trigger.pubsub) return "pubsub";
		if (trigger.webhook) return "webhook";
		if (trigger.websocket) return "websocket";
		if (trigger.sse) return "sse";
		if (trigger.worker) return "worker";
		if (trigger.manual) return "manual";
		return "unknown";
	}

	private getTriggerDetail(trigger: WorkflowDef["trigger"]): string {
		if (trigger.http) return `HTTP ${trigger.http.method} ${trigger.http.path}`;
		if (trigger.grpc) return `gRPC ${trigger.grpc.service}.${trigger.grpc.method}`;
		if (trigger.cron) return `Cron: ${trigger.cron.schedule}`;
		if (trigger.queue) return `Queue: ${trigger.queue.provider}/${trigger.queue.topic}`;
		if (trigger.pubsub) return `PubSub: ${trigger.pubsub.provider}/${trigger.pubsub.topic}`;
		if (trigger.webhook) return `Webhook: ${trigger.webhook.source} [${trigger.webhook.events.join(", ")}]`;
		if (trigger.websocket) return `WebSocket: ${trigger.websocket.path || "/ws"}`;
		if (trigger.sse) return `SSE: ${trigger.sse.path || "/events"}`;
		if (trigger.worker) return `Worker: ${trigger.worker.queue || "default"}`;
		if (trigger.manual) return "Manual";
		return "Unknown Trigger";
	}

	private countSteps(steps: StepDef[]): number {
		let count = steps.length;
		for (const step of steps) {
			if (step.conditions) {
				for (const cond of step.conditions) {
					if (cond.steps) {
						count += this.countSteps(cond.steps);
					}
				}
			}
		}
		return count;
	}

	// -- Mermaid helpers --

	private mermaidNode(node: GraphNode, prefix: string): string {
		const id = `${prefix}${node.id}`;
		const label = node.label.replace(/"/g, "'");

		switch (node.type) {
			case "trigger":
				return `${id}(["\`${label}\`"]):::trigger`;
			case "step":
				return `${id}["${label}"]:::step`;
			case "condition":
				return `${id}{"${label}"}:::condition`;
			case "end":
				return `${id}(["${label}"]):::endNode`;
			default:
				return `${id}["${label}"]`;
		}
	}

	private mermaidEdge(edge: GraphEdge, prefix: string): string {
		const from = `${prefix}${edge.from}`;
		const to = `${prefix}${edge.to}`;

		let arrow: string;
		switch (edge.style) {
			case "dashed":
				arrow = edge.label ? `-. "${edge.label}" .->` : "-.->"; break;
			case "dotted":
				arrow = edge.label ? `-. "${edge.label}" .->` : "-.->"; break;
			default:
				arrow = edge.label ? `-- "${edge.label}" -->` : "-->"; break;
		}

		return `${from} ${arrow} ${to}`;
	}

	// -- DOT helpers --

	private dotNode(node: GraphNode, prefix: string): string {
		const id = `${prefix}${node.id}`;
		const label = node.label.replace(/"/g, '\\"');

		switch (node.type) {
			case "trigger":
				return `${id} [label="${label}", shape=hexagon, style=filled, fillcolor="#4CAF50", fontcolor=white];`;
			case "step":
				return `${id} [label="${label}", shape=box, style="filled,rounded", fillcolor="#2196F3", fontcolor=white];`;
			case "condition":
				return `${id} [label="${label}", shape=diamond, style=filled, fillcolor="#FF9800", fontcolor=white];`;
			case "end":
				return `${id} [label="${label}", shape=ellipse, style=filled, fillcolor="#9E9E9E", fontcolor=white];`;
			default:
				return `${id} [label="${label}"];`;
		}
	}

	private dotEdge(edge: GraphEdge, prefix: string): string {
		const from = `${prefix}${edge.from}`;
		const to = `${prefix}${edge.to}`;
		const attrs: string[] = [];

		if (edge.label) {
			attrs.push(`label="${edge.label}"`);
		}
		if (edge.style === "dashed" || edge.style === "dotted") {
			attrs.push("style=dashed");
		}

		const attrStr = attrs.length > 0 ? ` [${attrs.join(", ")}]` : "";
		return `${from} -> ${to}${attrStr};`;
	}

	// -- ASCII helpers --

	private asciiIcon(type: GraphNode["type"]): string {
		switch (type) {
			case "trigger": return "⚡";
			case "step": return "▪️";
			case "condition": return "◆";
			case "end": return "⏹";
			default: return "•";
		}
	}

	private padRight(str: string, length: number): string {
		return str + " ".repeat(Math.max(0, length - str.length));
	}

	private sanitizeId(name: string): string {
		return name.replace(/[^a-zA-Z0-9]/g, "_");
	}
}

export interface WorkflowSummary {
	name: string;
	version: string;
	description?: string;
	triggerType: string;
	triggerDetail: string;
	stepCount: number;
	nodeCount: number;
	hasConditions: boolean;
	runtimes: string[];
}
