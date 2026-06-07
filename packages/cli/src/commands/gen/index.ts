import { Command } from "commander";
import type { OptionValues } from "../../services/commander.js";
import { program } from "../../services/commander.js";
import { generateAppTypes } from "./appTypes.js";

const gen = new Command("gen").description("Generate typed client artifacts for @blokjs/client");

const appTypes = new Command("app-types")
	.description("Generate the typed `BlokApp` index (blok-app.d.ts) from your TS workflow files")
	.option(
		"-d, --dir <value>",
		"TS workflows directory (defaults to triggers/http/src/workflows, src/workflows, or workflows)",
	)
	.option("-o, --out <value>", "Output file (default: ./blok-app.d.ts)")
	.option("--dry-run", "Print the generated file without writing it")
	.action(async (options: OptionValues) => {
		await generateAppTypes(options);
	});

gen.addCommand(appTypes);

program.addCommand(gen);
