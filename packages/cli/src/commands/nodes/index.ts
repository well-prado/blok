import { Command } from "commander";
import type { OptionValues } from "../../services/commander.js";
import { program } from "../../services/commander.js";
import { listNodes } from "./listNodes.js";

const nodes = new Command("nodes").description("Inspect the node catalog of a running Blok server");

const list = new Command("list")
	.description("List every node across all runtimes (hits GET /__blok/nodes on a running server)")
	.option("-u, --url <value>", "Base URL of the running Blok server", "http://localhost:4000")
	.option("--json", "Output raw JSON instead of a table")
	.action(async (options: OptionValues) => {
		await listNodes(options);
	});

nodes.addCommand(list);

program.addCommand(nodes);
