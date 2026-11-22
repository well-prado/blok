// The example's tools for AI agents, on standard input and output. An agent's program starts this file:
//
//     { "command": "bun", "args": ["mcp.ts"] }
import { blokMcp } from "@blokjs/kernel/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadBlok } from "./app.ts";
import { fakePorts } from "./ports/index.ts";

const server = await blokMcp(await loadBlok(fakePorts()), {
	name: "blok-pattern-prototype",
	version: "1.0.0",
	instructions: "Tools of the example shop. quote_order prices a basket and places nothing.",
});
await server.connect(new StdioServerTransport());
