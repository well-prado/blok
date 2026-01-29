import fs from "node:fs";
import * as p from "@clack/prompts";
import type { VisualizerWorkflowDef } from "@nanoservice-ts/runner";
import { type OptionValues, program, trackCommandExecution } from "../../services/commander.js";
import { loadWorkflows } from "../../services/workflow-loader.js";

// NodeDependencyGraph is imported dynamically to avoid circular dependency issues at CLI startup
async function getNodeDependencyGraph() {
	const { NodeDependencyGraph } = await import("@nanoservice-ts/runner");
	return NodeDependencyGraph;
}

program
	.command("graph")
	.description("Visualize node dependencies across workflows")
	.option("--format <format>", "Output format: ascii, mermaid, dot, json", "ascii")
	.option("--workflow <name>", "Filter to a specific workflow")
	.option("--node <name>", "Show dependencies for a specific node")
	.option("--output <file>", "Write output to file instead of stdout")
	.option("--direction <dir>", "Graph direction: TB, LR, BT, RL", "TB")
	.option("-d, --directory [value]", "Project directory", process.cwd())
	.action(async (options: OptionValues) => {
		await trackCommandExecution({
			command: "graph",
			args: options,
			execution: async () => {
				const logger = p.spinner();
				logger.start("Loading workflows...");

				const workflows = await loadWorkflows(options.directory as string);

				if (workflows.length === 0) {
					logger.stop("No workflow files found.", 1);
					p.log.warn("Make sure your project has workflow JSON files in the workflows/ directory.");
					return;
				}

				logger.stop(`Found ${workflows.length} workflow(s).`);

				const NodeDependencyGraph = await getNodeDependencyGraph();
				const graph = new NodeDependencyGraph({
					direction: (options.direction as "TB" | "LR" | "BT" | "RL") || "TB",
					filterWorkflow: (options.workflow as string) || "",
					filterNode: (options.node as string) || "",
					showWorkflowBoundaries: true,
					showOrphanNodes: true,
				});

				for (const wf of workflows) {
					graph.addWorkflow(wf.def as unknown as VisualizerWorkflowDef);
				}

				let output: string;
				const format = options.format as string;

				switch (format) {
					case "mermaid":
						output = graph.toMermaid();
						break;
					case "dot":
						output = graph.toDot();
						break;
					case "json":
						output = graph.toJson();
						break;
					default:
						output = graph.toAscii();
				}

				if (options.output) {
					fs.writeFileSync(options.output as string, output, "utf-8");
					p.log.success(`Graph written to ${options.output}`);
				} else {
					console.log(output);
				}

				// Show stats
				const stats = graph.getStats();
				p.log.info(
					`Nodes: ${stats.totalNodes} | Edges: ${stats.totalEdges} | Shared: ${stats.sharedNodes} | Orphans: ${stats.orphanNodes}`,
				);
			},
		});
	});
