// Serves every workflow that has an mcp trigger as a tool an AI agent can call, over the Model Context
// Protocol. The server is the official SDK's, so it speaks whatever transport you connect it to:
//
//     const server = await blokMcp(app, { name: "shop", version: "1.0.0" });
//     await server.connect(new StdioServerTransport());
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BlokError, type ToolBinding, mayWorkLater } from "./kernel.ts";
import { type App, type AppOptions, ready } from "./project.ts";

export interface McpInfo {
	name: string;
	version: string;
	/** What the whole set of tools is for. An agent reads it once, when it connects. */
	instructions?: string;
}

export async function blokMcp(source: App | AppOptions, info: McpInfo): Promise<Server> {
	const { bindings, call, log } = await ready(source);
	const tools = new Map(
		bindings
			.filter((binding): binding is ToolBinding => binding.kind === "mcp")
			.map((binding) => [binding.tool, binding]),
	);
	const server = new Server(
		{ name: info.name, version: info.version },
		{ capabilities: { tools: {} }, instructions: info.instructions },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [...tools.values()].map((tool) => ({
			name: tool.tool,
			description: tool.description,
			inputSchema: tool.input as { type: "object" },
			...(tool.output ? { outputSchema: tool.output as { type: "object" } } : {}),
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const tool = tools.get(request.params.name);
		const said = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], isError });
		if (!tool) return said(`There is no tool called "${request.params.name}".`, true);
		try {
			const output = await call(tool.unit, { body: request.params.arguments ?? {} });
			const text = JSON.stringify(output ?? null);
			// A tool that promised the shape of its answer also gives the answer as data, not only as text.
			return tool.output ? { ...said(text), structuredContent: output as Record<string, unknown> } : said(text);
		} catch (err) {
			const error = err instanceof BlokError ? err : new BlokError("unexpected", String(err), tool.unit.id);
			// A refusal is something the agent can read and act on. What broke inside is for the log.
			if (!mayWorkLater(error.code)) return said(`${error.code}: ${error.message}`, true);
			log.error(
				`${tool.unit.id}, called as the tool "${tool.tool}", failed with "${error.code}" at ${error.node}: ${error.message}`,
			);
			return said(`${error.code}: The tool could not complete the call.`, true);
		}
	});
	return server;
}
