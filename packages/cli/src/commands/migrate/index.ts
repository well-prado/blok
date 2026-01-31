import { Command } from "commander";
import { program } from "../../services/commander.js";
import type { OptionValues } from "..//../services/commander.js";
import { migrateNode } from "./node.js";

const migrate = new Command("migrate").description("Migrate nodes and workflows to newer patterns");

const node = new Command("node")
	.description("Migrate a class-based node to function-first pattern")
	.option("-p, --path <value>", "Path to the node file to migrate")
	.option("--backup", "Create backup before migration (default in non-interactive mode)")
	.option("--no-backup", "Skip backup creation")
	.action(async (options: OptionValues) => {
		await migrateNode(options);
	});

migrate.addCommand(node);

program.addCommand(migrate);
