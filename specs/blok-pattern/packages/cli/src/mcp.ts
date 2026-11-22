// mcp: the catalog and the checks as tools an AI agent can call, over the Model Context Protocol on stdio.
// Every tool call runs the matching command in a fresh process, so it always sees the project as it is on disk.
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Paths } from "./analyze.ts";
import { VERSION } from "./scaffold.ts";

const SELF = fileURLToPath(new URL("./cli.js", import.meta.url));
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

interface Tool {
	name: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
		additionalProperties: false;
	};
	command: (args: Record<string, unknown>) => string[];
}

const id = {
	type: "string",
	description: 'A node such as "billing/charge-card@1", or a workflow such as "workflows/checkout@1".',
};
const TOOLS: Tool[] = [
	{
		name: "blok_list",
		description:
			"Every node and workflow in this project: what each takes, what it answers with, its errors, and the name to write for it in a Pkl workflow. Call this before reading code.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		command: () => ["list", "--json"],
	},
	{
		name: "blok_show",
		description:
			"One node or workflow in full: its contract as JSON Schema, its folder, its tests, and which workflows use it.",
		inputSchema: { type: "object", properties: { id }, required: ["id"], additionalProperties: false },
		command: (args) => ["show", String(args.id), "--json"],
	},
	{
		name: "blok_status",
		description:
			"The work queue: which nodes still have no logic, which have no test, and which have no locked contract.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		command: () => ["status", "--json"],
	},
	{
		name: "blok_check",
		description:
			"Says whether every workflow lines up with its nodes, with each problem as a full sentence. With a node id it is the gate for that one node: its contract is unchanged, its logic is written, and its tests pass.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "A node, to also run its tests. Leave out to check the wiring of the whole project.",
				},
			},
			additionalProperties: false,
		},
		command: (args) => ["check", ...(args.id ? [String(args.id)] : []), "--json"],
	},
	{
		name: "blok_prompt",
		description:
			"The brief for writing one node: its fixed contract, its folder, what it may touch, and when it is done.",
		inputSchema: { type: "object", properties: { id }, required: ["id"], additionalProperties: false },
		command: (args) => ["prompt", "build", String(args.id)],
	},
];

interface Request {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
}

function answer(paths: Paths, request: Request): unknown {
	if (request.method === "initialize") {
		const asked = String(request.params?.protocolVersion ?? "");
		return {
			protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
			capabilities: { tools: {} },
			serverInfo: { name: "blokctl", version: VERSION },
			instructions:
				"Tools for a Blok backend. Logic lives in nodes, and workflows wire them. Start with blok_list, and run blok_check before saying a change is done.",
		};
	}
	if (request.method === "ping") return {};
	if (request.method === "tools/list") {
		return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
	}
	if (request.method === "tools/call") {
		const tool = TOOLS.find((candidate) => candidate.name === request.params?.name);
		if (!tool) throw { code: -32602, message: `There is no tool called "${request.params?.name}".` };
		const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
		const missing = (tool.inputSchema.required ?? []).filter(
			(key) => typeof args[key] !== "string" || args[key] === "",
		);
		if (missing.length > 0) {
			return { content: [{ type: "text", text: `${tool.name} needs "${missing.join('", "')}".` }], isError: true };
		}
		const run = spawnSync(process.execPath, [SELF, ...tool.command(args), "--dir", paths.dir], {
			cwd: paths.root,
			encoding: "utf8",
		});
		// A check that finds problems is a result the agent needs to read, so it is not a failed call.
		const text = (run.stdout.trim() || run.stderr.trim()) ?? "";
		return { content: [{ type: "text", text }], isError: run.status !== 0 && run.stdout.trim() === "" };
	}
	throw { code: -32601, message: `"${request.method}" is not supported.` };
}

/** Serves until the other side closes the stream. Messages are one JSON object per line. */
export function mcp(paths: Paths): Promise<void> {
	const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	const lines = createInterface({ input: process.stdin });
	lines.on("line", (line) => {
		if (line.trim() === "") return;
		let request: Request;
		try {
			request = JSON.parse(line);
		} catch {
			return send({ id: null, error: { code: -32700, message: "That line is not JSON." } });
		}
		// A message with no id is a notification, such as "initialized". It gets no answer.
		if (request.id === undefined) return;
		try {
			send({ id: request.id, result: answer(paths, request) });
		} catch (err) {
			const known = err as { code?: number; message?: string };
			send({ id: request.id, error: { code: known.code ?? -32603, message: known.message ?? String(err) } });
		}
	});
	return new Promise((done) => lines.on("close", done));
}
