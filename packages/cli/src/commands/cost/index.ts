import fs from "node:fs";
import * as p from "@clack/prompts";
import { type OptionValues, program, trackCommandExecution } from "../../services/commander.js";
import { loadWorkflow, loadWorkflows } from "../../services/workflow-loader.js";

async function getCostEstimator() {
	const { CostEstimator } = await import("@nanoservice-ts/runner");
	return CostEstimator;
}

program
	.command("cost [workflow-name]")
	.description("Estimate execution costs for workflows")
	.option("--executions <count>", "Monthly execution count", "10000")
	.option("--provider <provider>", "Cloud provider: aws, gcp, azure, local", "aws")
	.option("--format <format>", "Output format: table, json", "table")
	.option("--output <file>", "Write output to file")
	.option("-d, --directory [value]", "Project directory", process.cwd())
	.action(async (workflowName: string | undefined, options: OptionValues) => {
		await trackCommandExecution({
			command: "cost",
			args: options,
			execution: async () => {
				const logger = p.spinner();
				logger.start("Loading workflows...");

				const directory = options.directory as string;
				const provider = (options.provider as string) || "aws";
				const executions = Number.parseInt(options.executions as string, 10) || 10_000;

				let workflows: Awaited<ReturnType<typeof loadWorkflows>> = [];
				if (workflowName) {
					const wf = await loadWorkflow(directory, workflowName);
					if (!wf) {
						logger.stop(`Workflow "${workflowName}" not found.`, 1);
						return;
					}
					workflows = [wf];
				} else {
					workflows = await loadWorkflows(directory);
				}

				if (workflows.length === 0) {
					logger.stop("No workflow files found.", 1);
					p.log.warn("Make sure your project has workflow JSON files in the workflows/ directory.");
					return;
				}

				logger.stop(`Found ${workflows.length} workflow(s).`);

				const CostEstimator = await getCostEstimator();
				const estimator = new CostEstimator({
					provider: provider as "aws" | "gcp" | "azure" | "local",
					executionsPerMonth: executions,
				});

				for (const wf of workflows) {
					estimator.estimateWorkflow(wf.def as Record<string, unknown>);
				}

				let output: string;
				const format = options.format as string;

				switch (format) {
					case "json":
						output = estimator.toJson();
						break;
					default:
						output = estimator.toTable();
				}

				if (options.output) {
					fs.writeFileSync(options.output as string, output, "utf-8");
					p.log.success(`Cost estimate written to ${options.output}`);
				} else {
					console.log(output);
				}

				// Summary
				const estimates = estimator.getEstimates();
				const totalMonthly = estimates.reduce((sum: number, e: { monthlyCost: number }) => sum + e.monthlyCost, 0);
				p.log.info(
					`Total estimated monthly cost (${provider.toUpperCase()}, ${executions.toLocaleString()} exec/month): $${totalMonthly.toFixed(2)}`,
				);
			},
		});
	});
