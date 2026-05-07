import { Command } from "commander";
import { program } from "../../services/commander.js";
import type { OptionValues } from "..//../services/commander.js";
import { migrateNode } from "./node.js";
import { migratePaths } from "./paths.js";
import { migrateWorkflows } from "./workflows.js";

const migrate = new Command("migrate").description("Migrate nodes and workflows to newer patterns");

const node = new Command("node")
	.description("Migrate a class-based node to function-first pattern")
	.option("-p, --path <value>", "Path to the node file to migrate")
	.option("--backup", "Create backup before migration (default in non-interactive mode)")
	.option("--no-backup", "Skip backup creation")
	.action(async (options: OptionValues) => {
		await migrateNode(options);
	});

const workflows = new Command("workflows")
	.description("Migrate v1 JSON workflows to the v2 shape (id+use+inputs, branch primitive, ANY method)")
	.option(
		"-d, --dir <value>",
		"Path to the JSON workflows directory (defaults to ./workflows/json or ./triggers/http/workflows/json)",
	)
	.option("--dry-run", "Print what would change without writing files")
	.option("--backup", "Create .bak files next to each migrated workflow (default true)")
	.option("--no-backup", "Skip backup creation")
	.action(async (options: OptionValues) => {
		await migrateWorkflows(options);
	});

const paths = new Command("paths")
	.description(
		"Add explicit `trigger.http.path` to every JSON HTTP workflow (prep for v0.4 explicit-path-only routing)",
	)
	.option(
		"-d, --dir <value>",
		"Path to the JSON workflows directory (defaults to ./workflows/json or ./triggers/http/workflows/json)",
	)
	.option("--dry-run", "Print what would change without writing files")
	.option("--backup", "Create .bak files next to each migrated workflow (default true)")
	.option("--no-backup", "Skip backup creation")
	.action(async (options: OptionValues) => {
		await migratePaths(options);
	});

migrate.addCommand(node);
migrate.addCommand(workflows);
migrate.addCommand(paths);

program.addCommand(migrate);
