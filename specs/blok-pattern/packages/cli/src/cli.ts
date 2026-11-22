#!/usr/bin/env node
import { analyze, locate } from "./analyze.ts";
import { type Report, build, check, list } from "./commands.ts";
import { dev } from "./dev.ts";
import { doctor } from "./doctor.ts";
import { show, status } from "./inspect.ts";
import { lock } from "./lock.ts";
import { mcp } from "./mcp.ts";
import { openapi } from "./openapi.ts";
import { buildPrompt, designPrompt } from "./prompt.ts";
import { run } from "./run.ts";
import { VERSION, init, newNode, newVersion, newWorkflow } from "./scaffold.ts";

const HELP = `blokctl ${VERSION}

Start
  blokctl init [name]                    Start a new project, or add Blok to the app in this folder
  blokctl new node <module>/<node>       Create a node: its folder, its contract and a test
  blokctl new workflow <name>            Create a workflow, started by HTTP unless --trigger says otherwise
  blokctl new version <module>/<node>    Copy a node's newest version to the next one

Look
  blokctl list                           Every node and workflow, with what each takes and answers with
  blokctl show <id>                      One node or workflow in full
  blokctl status                         Which nodes are still empty, untested or not locked
  blokctl doctor                         What is missing on this machine or in this project

Check and ship
  blokctl check                          Say whether every workflow lines up with its nodes
  blokctl check <node>                   The gate for one node: contract unchanged, logic written, tests pass
  blokctl lock [node]                    Write contract.json beside each node, so its contract cannot drift
  blokctl build                          Check, then write the JSON production loads into .blok/
  blokctl openapi                        Print the HTTP routes as an OpenAPI 3.1 document
  blokctl dev -- <start command>         Rebuild and restart the app on every change
  blokctl run <id> --input '<json>'      Run one node or workflow here, with the project's ports

For AI agents
  blokctl prompt design                  The brief for designing an app: contracts and wiring, no logic
  blokctl prompt build <node>            The brief for writing one node
  blokctl mcp                            Serve list, show, status, check and prompt as MCP tools on stdio

Options
  --dir <folder>    The folder that holds nodes/ and workflows/. Default: this one, or "blok.dir" in package.json
  --json            Print the result as JSON. On "new workflow": write the workflow as JSON, not Pkl
  --trigger <kind>  new workflow: what starts it: http, cron, queue or mcp
  --server <name>   init <name>: the server of the new project: fastify, hono or express
  --tests           check: also run every node's tests
  --allow-empty     build: also build while some nodes are still \`todo\`
  --ports <file>    run: take the ports from this file instead of ports/index
`;

function usage(message: string): never {
	console.error(`${message}\n\nRun "blokctl --help" to see the commands.`);
	process.exit(2);
}

const VALUED = new Set(["dir", "input", "ports", "trigger", "server"]);

async function main(argv: string[]): Promise<void> {
	const split = argv.indexOf("--");
	const after = split >= 0 ? argv.slice(split + 1) : [];
	const before = split >= 0 ? argv.slice(0, split) : argv;

	const flags = new Map<string, string | true>();
	const words: string[] = [];
	for (let i = 0; i < before.length; i++) {
		const word = before[i];
		if (!word.startsWith("--")) words.push(word);
		else if (VALUED.has(word.slice(2))) {
			const value = before[++i];
			if (value === undefined) usage(`${word} needs a value.`);
			flags.set(word.slice(2), value);
		} else flags.set(word.slice(2), true);
	}
	if (flags.has("version")) return void console.log(VERSION);
	if (flags.has("help") || words.length === 0) return void console.log(HELP);

	const [command, ...rest] = words;
	const cwd = process.cwd();
	const text = (name: string) => flags.get(name) as string | undefined;
	const paths = locate(cwd, text("dir"));
	const need = (what: string, example: string): string => rest[0] ?? usage(`Say ${what}: ${example}`);

	let report: Report;
	if (command === "init") report = init(cwd, { name: rest[0], dir: text("dir"), server: text("server") });
	else if (command === "check") report = await check(paths, { id: rest[0], tests: flags.has("tests") });
	else if (command === "build") report = await build(paths, { allowEmpty: flags.has("allow-empty") });
	else if (command === "list") report = list(await analyze(paths));
	else if (command === "openapi") {
		report = openapi(await analyze(paths), paths);
		// The document is JSON either way.
		flags.delete("json");
	} else if (command === "status") report = status(await analyze(paths), paths);
	else if (command === "show")
		report = show(await analyze(paths), paths, need("what to show", "blokctl show billing/charge-card"));
	else if (command === "lock") report = lock(await analyze(paths), paths, rest[0]);
	else if (command === "doctor") report = await doctor(paths);
	else if (command === "dev") return void (await dev(paths, after));
	else if (command === "mcp") return void (await mcp(paths));
	else if (command === "run") {
		const id = need("what to run", `blokctl run billing/charge-card --input '{"token":"tok_1"}'`);
		report = await run(await analyze(paths), paths, id, { input: text("input"), ports: text("ports") });
	} else if (command === "prompt") {
		const [kind, id] = rest;
		if (kind === "design") report = designPrompt(paths);
		else if (kind === "build" && id) report = buildPrompt(await analyze(paths), paths, id);
		else usage('Say which brief: "blokctl prompt design", or "blokctl prompt build <module>/<node>".');
	} else if (command === "new") {
		const [kind, name] = rest;
		if (!name)
			usage(
				"Say what to create: blokctl new node <module>/<node>, new workflow <name>, or new version <module>/<node>.",
			);
		if (kind === "node") report = newNode(paths, name);
		else if (kind === "workflow")
			report = newWorkflow(paths, name, { json: flags.has("json"), trigger: text("trigger") });
		else if (kind === "version") report = newVersion(paths, name);
		else usage(`"${kind}" cannot be created. Use node, workflow or version.`);
		// `--json` on `new workflow` chooses the file format, so its own result is printed as text.
		if (kind === "workflow") flags.delete("json");
	} else usage(`"${command}" is not a command.`);

	if (flags.has("json")) console.log(JSON.stringify(report.data, null, 2));
	else (report.ok ? console.log : console.error)(report.text);
	process.exitCode = report.ok ? 0 : 1;
}

main(process.argv.slice(2)).catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
});
