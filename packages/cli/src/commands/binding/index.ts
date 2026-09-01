import { readFile } from "node:fs/promises";
import { explainWorkflowBinding, resolveWorkflowBinding } from "@blokjs/runner";
import { Command } from "commander";
import { type OptionValues, program, withErrorBoundary } from "../../services/commander.js";

async function readJson(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8"));
}

export async function explainWorkflowBindingCommand(options: OptionValues): Promise<void> {
	const catalog = await readJson(options.catalog as string);
	const inputs = await readJson(options.task as string);
	if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs))
		throw new Error("Workflow binding inputs JSON must be an object.");
	if (catalog === null || typeof catalog !== "object" || Array.isArray(catalog))
		throw new Error("Binding catalog JSON must be an object.");

	const resolution = resolveWorkflowBinding({
		inputs: inputs as Parameters<typeof resolveWorkflowBinding>[0]["inputs"],
		catalog: catalog as Parameters<typeof resolveWorkflowBinding>[0]["catalog"],
	});
	if (options.json) {
		console.log(JSON.stringify(resolution, null, 2));
		return;
	}
	console.log(explainWorkflowBinding(resolution));
}

const binding = new Command("binding").description("Resolve and explain workflow enforcement bindings");

binding
	.command("explain")
	.description("Explain why a workflow and enforcement profile were selected")
	.requiredOption("--catalog <file>", "Binding catalog JSON file")
	.requiredOption("--task <file>", "Task metadata JSON file")
	.option("--json", "Emit the complete machine-readable resolution")
	.action(withErrorBoundary(async (options: OptionValues) => explainWorkflowBindingCommand(options)));

program.addCommand(binding);
