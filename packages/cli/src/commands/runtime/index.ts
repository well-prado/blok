import { Command } from "commander";
import { type OptionValues, program } from "../../services/commander.js";
import { runtimeAdd } from "./add.js";
import { runtimeList } from "./list.js";
import { runtimeRemove } from "./remove.js";

const runtime = new Command("runtime").description("Add, remove, or list language runtimes in an existing project");

// Bare `blokctl runtime` shows the subcommand help instead of a terse usage line.
runtime.action(() => {
	runtime.help();
});

runtime
	.command("add")
	.description("Add a language runtime (go, rust, java, csharp, php, ruby, python3) to this project")
	.argument("[runtime]", "Runtime to add (omit for an interactive picker)")
	.option("-d, --directory <path>", "Project directory (default: current directory)")
	.option("--local <path>", "Use a local blok repo for SDK source instead of fetching by version")
	.option("--grpc-port <port>", "Override the gRPC port for this runtime")
	.option("--force", "Reinstall if the runtime is already present")
	.option("--skip-toolchain-check", "Add even if the language toolchain isn't detected")
	.option("-y, --yes", "Skip prompts (non-interactive)")
	.action(async (runtimeArg: string | undefined, options: OptionValues) => {
		await runtimeAdd(runtimeArg, options);
	});

runtime
	.command("remove")
	.alias("rm")
	.description("Remove a language runtime from this project")
	.argument("<runtime>", "Runtime to remove")
	.option("-d, --directory <path>", "Project directory (default: current directory)")
	.option("--purge-nodes", "Also delete your custom nodes in runtimes/<runtime>/nodes/")
	.option("-y, --yes", "Skip prompts (keeps your custom nodes)")
	.action(async (runtimeArg: string, options: OptionValues) => {
		await runtimeRemove(runtimeArg.toLowerCase(), options);
	});

runtime
	.command("list")
	.alias("ls")
	.description("List installed runtimes and which are available to add")
	.option("-d, --directory <path>", "Project directory (default: current directory)")
	.option("--json", "Output as JSON")
	.action(async (options: OptionValues) => {
		await runtimeList(options);
	});

program.addCommand(runtime);
