import * as p from "@clack/prompts";
import { Command, type OptionValues, trackCommandExecution } from "../../services/commander.js";
import { BLOK_URL } from "../../services/constants.js";
import { tokenManager } from "../../services/local-token-manager.js";
import { isNonInteractive } from "../../services/non-interactive.js";

import { install } from "../install/workflow.js";

interface WorkflowSchema {
	name: string;
	version: string;
	description?: string;
	steps?: Array<{
		name: string;
		node: string;
		type: "local" | "module" | "runtime.python3";
		inputs?: Record<string, unknown>;
	}>;
	nodes?: Record<
		string,
		{
			inputs?: Record<string, unknown>;
		}
	>;
	trigger?: {
		[K in "http" | "cron" | "manual" | "grpc"]?: {
			method?: string;
			path?: string;
			accept?: string;
		};
	};
}
interface Workflow {
	_id: string;
	id: string;
	workflow: WorkflowSchema;
}

interface WorkflowOption extends Workflow {
	label: string;
	value: string;
}

async function searchWorkflow(opts: OptionValues) {
	const response = await fetch(`${BLOK_URL}/published-workflow?workflow_name=${opts.workflow}`, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${opts.token}`,
		},
	});
	if (!response.ok) throw new Error(response.statusText);

	const searchs = await response.json();

	return searchs.documents;
}

export async function search(opts: OptionValues) {
	const token = tokenManager.getToken();
	const logger = p.spinner();
	try {
		if (!token) throw new Error("Token is required.");
		if (!opts.workflow) throw new Error("Workflow argument is required.");
		opts.token = token;

		logger.start("Searching for workflow...");

		const searchs = await searchWorkflow(opts);

		if (searchs.length === 0) {
			throw new Error("No workflow found.");
		}

		// --list flag: print results and exit without prompting
		if (opts.list || (isNonInteractive() && !opts.install)) {
			logger.stop(`Found ${searchs.length} workflow(s):`);
			for (const data of searchs as Workflow[]) {
				p.log.info(`${data.id} (${data.workflow.name}:${data.workflow.version} - ${data.workflow.description})`);
			}
			return;
		}

		// --install flag: install a specific workflow by ID without prompting
		if (opts.install) {
			const workflowInfo = searchs.find((workflow: Workflow) => workflow.id === opts.install);
			if (!workflowInfo) throw new Error(`Workflow "${opts.install}" not found in search results.`);
			logger.stop(`Starting installation of ${workflowInfo.id}...`);
			await trackCommandExecution({
				command: "install",
				args: opts,
				execution: async () => {
					opts.workflow = workflowInfo.id;
					if (!opts.directory) opts.directory = process.cwd();
					await install(opts);
				},
			});
			return;
		}

		const selectedWorkflow: WorkflowOption | Workflow | symbol = await p.select<WorkflowOption>({
			message: "Select a workflow to install",
			options: searchs.map((data: Workflow) => ({
				label: `${data.id} (${data.workflow.name}:${data.workflow.version} - ${data.workflow.description})`,
				value: data,
			})),
		});

		if (!selectedWorkflow || typeof selectedWorkflow === "symbol") throw new Error("No workflow selected.");
		// Find the full package info from pkgList
		const workflowInfo = searchs.find((workflow: Workflow) => workflow.id === (selectedWorkflow as Workflow).id);
		if (!workflowInfo) throw new Error("Selected workflow not found.");

		logger.stop(`Starting installation of ${workflowInfo.id}...`);
		await trackCommandExecution({
			command: "install",
			args: opts,
			execution: async () => {
				opts.workflow = workflowInfo.id;
				if (!opts.directory) opts.directory = process.cwd();
				await install(opts);
			},
		});
	} catch (error) {
		logger.error((error as Error).message);
	}
}

export default new Command()
	.command("workflow")
	.description("Search for a workflow")
	.option("-i, --install <value>", "Workflow ID to auto-install (skip select prompt)")
	.option("-l, --list", "List results without prompting to install")
	.argument("<workflow>", "Workflow hints")
	.action(async (workflow: string, options: OptionValues) => {
		await trackCommandExecution({
			command: "search workflow",
			args: options,
			execution: async () => {
				options.workflow = workflow;
				await search(options);
			},
		});
	});
