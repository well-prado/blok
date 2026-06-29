import { Command } from "commander";
import type { OptionValues } from "../../services/commander.js";
import { program } from "../../services/commander.js";
import { listNodes } from "./listNodes.js";
import { syncNodes } from "./syncNodes.js";

const nodes = new Command("nodes").description("Inspect the node catalog of a running Blok server");

const list = new Command("list")
	.description("List every node across all runtimes (hits GET /__blok/nodes on a running server)")
	.option("-u, --url <value>", "Base URL of the running Blok server", "http://localhost:4000")
	.option("--json", "Output raw JSON instead of a table")
	.action(async (options: OptionValues) => {
		await listNodes(options);
	});

const sync = new Command("sync")
	.description("Generate typed runtimeNode stubs (one file per runtime) from the catalog at GET /__blok/nodes")
	.option("-u, --url <value>", "Base URL of the running Blok server", "http://localhost:4000")
	.option("-o, --out <dir>", "Output directory for the generated stubs", "nodes-gen")
	.option("--check", "CI mode: exit non-zero if checked-in stubs drift from freshly generated (writes nothing)")
	.action(async (options: OptionValues) => {
		await syncNodes(options);
	});

nodes.addCommand(list);
nodes.addCommand(sync);

program.addCommand(nodes);
