// The two briefs of the AI loop, written out, so every run hands its agents the same instructions.
import { relative } from "node:path";
import { contract } from "@blokjs/kernel";
import type { Analysis, Paths } from "./analyze.ts";
import type { Report } from "./commands.ts";
import { resolveNode, show } from "./inspect.ts";
import { ownCommand } from "./scaffold.ts";

/**
 * The design pass: one agent turns a product description into ports, node contracts and workflows.
 * No logic is written. The check proves the whole app lines up before a single node is filled in.
 */
export function designPrompt(paths: Paths): Report {
	const at = (path: string) => relative(paths.root, path) || ".";
	const lang = paths.language;
	const python = lang.name === "python";
	const blokctl = ownCommand(paths);
	// The same instructions in the words of the project's language.
	const words = python
		? {
				ports: "the `Ports` class and the classes it is made of",
				memory:
					"Define a `memory_ports()` function that returns a fresh in-memory version of every port, and `ports = memory_ports()`",
				errors:
					'Write `errors` as a dict, with when each one happens: `{"card_declined": "The provider refused the card."}`',
				describe: '`Field(description="...")`',
				app: "app.py",
			}
		: {
				ports: "the `Ports` interface",
				memory:
					"Export a `memoryPorts()` function that returns a fresh in-memory version of every port, and `export const ports = memoryPorts()`",
				errors:
					'Write `errors` as an object, with when each one happens: `{ card_declined: "The provider refused the card." }`',
				describe: "`.describe()`",
				app: "app.ts",
			};
	const text = `You are doing the DESIGN PASS of a Blok backend. You write contracts and wiring. You write no logic.

Read AGENTS.md first. It has the rules and one example of a node and of a workflow. Run the tool as \`${blokctl}\`${python ? "" : ", which is this project's own copy"}.

What to produce, in this order:

1. ${at(`${paths.dir}/${lang.portsFile}`)}: ${words.ports}. One entry for every outside thing the app needs: a database table, a payment provider, a mailer, a clock, an id generator. Keep each port small and named for what the app does with it, not for the product behind it. ${words.memory}, so the app runs with no setup and every test starts clean.
2. One node for every piece of work, created with \`blokctl new node <module>/<node>\`. In each ${lang.nodeFile} fill in \`description\`, \`input\`, \`output\` and \`errors\`, and leave \`${lang.todo}\`. ${words.errors}. Group nodes into modules by what they are about: orders, billing, users.
3. One workflow for every thing the app does from outside, created with \`blokctl new workflow <name>\`. Wire the nodes with typed references. A workflow that creates something answers \`status = 201\`. To refuse a request on a simple condition, use a \`Fail\` entry and not a node. Give every step that changes something outside an \`undo\`, so that a later failure takes it back. Every error a step can fail with needs a status in \`trigger.http.errors\`, and the check refuses a workflow that leaves one out.
   Not everything starts with an HTTP request. Work that happens at a time of day gets a \`cron\` trigger, work that follows a message gets a \`queue\` trigger, a webhook from another company gets an \`http\` trigger with a \`signature\`, and something an AI agent should be able to do gets an \`mcp\` trigger. \`blokctl new workflow <name> --trigger cron\` (or \`queue\`, \`mcp\`) writes the trigger. AGENTS.md, "What starts a workflow", has each form, the line \`${words.app}\` needs for it, and the rules that come with a queue. Add those lines to \`${words.app}\` in this pass, and when a node must send to a queue, give \`Ports\` an entry for it.
4. One test beside each node, in ${lang.testFile}, that states what the node must do: the normal case and each error in its contract. These tests fail now, because the logic is not written. They are the definition of done for whoever writes it.

Rules for a good design:

- A node does one thing and is small enough to write and test alone. If its description needs the word "and", split it. There is one exception: steps are not a transaction, so a rule that must hold at the moment of a write, such as a limit, a stock count or a unique email, belongs in the node that writes, done through one call to a port. Do not make it a separate step before the write.
- A node's input and output are the whole interface between agents. Whoever writes a node will see its contract, its tests and ${lang.portsFile}, and nothing else. Put everything they need to know there: exact field names, kinds, which fields are optional, every error code. Use ${words.describe} on a field whose meaning is not obvious from its name. The node's \`description\` is the only prose they get from you, so it must say everything the node does, including what it stores or changes, and when each error happens.
- An error code is all a caller and the next agent see of a failure. Name it so it explains itself, and say in the node's description when each one happens.
- Names are final after this pass. Choose module and node names carefully: a node's name is how every workflow writes it.
- Nothing shared is edited later. Everything two nodes need in common goes into ${lang.portsFile} now.

You are done when all of these hold:

- \`blokctl check\` says everything lines up. It will also say how many nodes are still empty: that is expected, and it should be all of them.
- \`blokctl lock\` has been run after the last contract change, so every node has a contract.json.
- \`blokctl status\` lists every node as empty, and says that every node's contract is locked.

The app to design is described below.
`;
	return { ok: true, text, data: { ok: true, prompt: text } };
}

/**
 * A contract as a person would want to read it. The schema library writes a long pattern beside every
 * format, and the largest safe integer as the bound of every integer. Neither is a rule of the app.
 */
export function readable(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(readable);
	if (schema === null || typeof schema !== "object") return schema;
	const kept = Object.entries(schema).filter(
		([key, value]) =>
			key !== "$schema" &&
			!(key === "pattern" && "format" in schema) &&
			!((key === "maximum" || key === "minimum") && Math.abs(value as number) === Number.MAX_SAFE_INTEGER),
	);
	return Object.fromEntries(kept.map(([key, value]) => [key, readable(value)]));
}

/** The build pass: the brief for one node. Many agents get one each and work at the same time. */
export function buildPrompt(analysis: Analysis, paths: Paths, given: string): Report {
	const id = resolveNode(analysis, given);
	const unit = id ? analysis.nodes.get(id) : undefined;
	if (!id || !unit) {
		const problem = `${given} is not a node. Run "blokctl status" to see the nodes that are still empty.`;
		return { ok: false, text: problem, data: { ok: false, problems: [problem] } };
	}
	const facts = show(analysis, paths, id).data as { folder: string; tests: string[]; locked: boolean };
	const described = contract(unit);
	const lang = paths.language;
	const python = lang.name === "python";
	const ports = relative(paths.root, `${paths.dir}/${lang.portsFile}`);
	// Only say the schemas were shortened when something was left out of them.
	const trimmed =
		JSON.stringify([readable(described.input), readable(described.output)]).length <
		JSON.stringify([described.input, described.output]).length -
			2 * '"$schema":"https://json-schema.org/draft/2020-12/schema",'.length;
	const blokctl = ownCommand(paths);
	const text = `You are writing ONE node of a Blok backend: ${id}.
${described.description ? `\nWhat it does: ${described.description}\n` : ""}
Read AGENTS.md first. It has the rules and one example of a node.

Your folder is ${facts.folder}/. Change files in that folder and nowhere else. Other agents are writing the other nodes at this moment, each in its own folder, and all of it is merged afterwards. A change outside your folder is a merge conflict for somebody.

The contract is fixed:

- Do not change \`id\`, \`input\`, \`output\` or \`errors\` in ${lang.nodeFile}${python ? ", nor the fields of the models they name" : ""}.${facts.locked ? " They are locked by contract.json, and the check refuses a node that differs from it." : ""}
- Do not edit contract.json.
- If the contract cannot be implemented as it stands, stop and say why. Do not change it to fit.

What it takes (JSON Schema${trimmed ? `, shortened: ${lang.nodeFile} has the exact schema` : ""}):

${JSON.stringify(readable(described.input), null, 2)}

What it answers with (JSON Schema):

${JSON.stringify(readable(described.output), null, 2)}

How it may fail: ${
		described.errors.length > 0
			? `${python ? 'raise one of these with `raise ctx.fail("<code>", "<message>")`' : 'throw one of these with `throw fail("<code>", "<message>")`'}. No other code is allowed.\n\n${described.errors
					.map((code) => `- ${code}${described.errorMeanings[code] ? `: ${described.errorMeanings[code]}` : ""}`)
					.join("\n")}`
			: "it declares no business errors, so it must not call `fail`."
	}

What to do:

1. Replace \`${lang.todo}\` in ${facts.folder}/${lang.nodeFile} with the logic, and remove the \`todo\` import, which nothing uses after that. Reach the outside world only through \`ports\`, which is typed in ${ports}. Read that file. Do not edit it. Return the output's fields and nothing else.
2. ${facts.tests.length > 0 ? `Make the test in ${facts.tests.join(", ")} pass. It states what the node must do. You may add cases. Do not weaken or remove the ones that are there.` : `Write ${facts.folder}/${lang.testFile}: the normal case and each error. Give the node fake ports that hold only what it uses.`}
3. Run \`${blokctl} check ${id}\` from the folder that holds ${lang.manifest}. You are done when it says the node is done. It runs the node's tests${python ? "" : ", checks its types with the project's TypeScript compiler,"} and compares its contract with what was locked.

Do not add a dependency, do not edit ${lang.manifest}, and do not touch a workflow.
`;
	return { ok: true, text, data: { ok: true, id, folder: facts.folder, prompt: text } };
}
