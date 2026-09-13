import { Command } from "commander";
import type { OptionValues } from "../../services/commander.js";
import { program, withErrorBoundary } from "../../services/commander.js";
import { generateAppTypes } from "./appTypes.js";

const gen = new Command("gen").description("Generate typed client artifacts for @blokjs/client");

const appTypes = new Command("app-types")
	.description(
		"Generate the typed `BlokApp` index (blok-app.d.ts), plus blok-pages.d.ts + blok-routes.ts for Inertia apps",
	)
	.option(
		"-d, --dir <value>",
		"TS workflows directory (defaults to triggers/http/src/workflows, src/workflows, or workflows)",
	)
	.option("-o, --out <value>", "Output file (./blok-app.d.ts) or, without a .ts suffix, an output DIRECTORY")
	.option("--pages-only", "Write only the Inertia files (blok-pages.d.ts, blok-routes.ts)")
	.option("--with-all-errors", "The app uses withAllErrors — type `errors` values as string[]")
	.option("--watch", "Regenerate whenever a workflow file changes")
	.option("--dry-run", "Print the generated files without writing them")
	.action(
		withErrorBoundary(async (options: OptionValues) => {
			await generateAppTypes(options);
		}),
	);

gen.addCommand(appTypes);

program.addCommand(gen);
