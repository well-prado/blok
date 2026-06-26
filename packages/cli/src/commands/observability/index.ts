import { Command } from "commander";
import { type OptionValues, program } from "../../services/commander.js";
import { observabilityAdd } from "./add.js";
import { OBSERVABILITY_MODULE_IDS } from "./descriptor.js";
import { observabilityList } from "./list.js";
import { observabilityRemove } from "./remove.js";
import { observabilityStatus } from "./status.js";

const MODULE_LIST = OBSERVABILITY_MODULE_IDS.join(", ");

const observability = new Command("observability")
	.alias("obs")
	.description("Add, remove, list, or check observability modules (metrics, tracing, logging, …) in a project");

// Bare `blokctl observability` shows the subcommand help instead of a terse usage line.
observability.action(() => {
	observability.help();
});

observability
	.command("add")
	.description(`Enable an observability module (${MODULE_LIST})`)
	.argument("[module]", "Module to add (omit for an interactive picker)")
	.option("-d, --directory <path>", "Project directory (default: current directory)")
	.option("--force", "Re-apply even if the module is already enabled")
	.option("--tier <tier>", "obs-stack only: none | lite | full (default: lite)")
	.option("--local <path>", "obs-stack only: copy infra from a local blok repo instead of fetching")
	.option("-y, --yes", "Skip prompts (non-interactive; auto-enables dependencies)")
	.action(async (moduleArg: string | undefined, options: OptionValues) => {
		await observabilityAdd(moduleArg, options);
	});

observability
	.command("remove")
	.alias("rm")
	.description("Disable an observability module")
	.argument("<module>", "Module to remove")
	.option("-d, --directory <path>", "Project directory (default: current directory)")
	.option("-y, --yes", "Skip confirmation (non-interactive)")
	.action(async (moduleArg: string, options: OptionValues) => {
		await observabilityRemove(moduleArg, options);
	});

observability
	.command("list")
	.alias("ls")
	.description("List enabled modules and which are available to add")
	.option("-d, --directory <path>", "Project directory (default: current directory)")
	.option("--json", "Output as JSON")
	.action(async (options: OptionValues) => {
		await observabilityList(options);
	});

observability
	.command("status")
	.description("Report the health of each enabled observability module")
	.option("-d, --directory <path>", "Project directory (default: current directory)")
	.action(async (options: OptionValues) => {
		await observabilityStatus(options);
	});

program.addCommand(observability);
