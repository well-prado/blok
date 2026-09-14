/**
 * The MCP page tools against the REAL react example (#1019, test 2).
 *
 * `triggers/mcp/src/McpTrigger.inertia.test.ts` covers the trigger wiring with
 * a registry it controls. This one proves the tools answer correctly for an app
 * nobody wrote for them: `examples/inertia-react`, through the BUILT packages,
 * exactly as an agent pointed at that app would see it.
 */

import { inertiaMcpTools } from "@blokjs/trigger-mcp";
import { beforeAll, describe, expect, it } from "vitest";
import dashboard from "../../examples/inertia-react/src/workflows/dashboard.js";

type Tool = Awaited<ReturnType<typeof inertiaMcpTools>>[number];

let tools: Tool[];

function tool(name: string): Tool {
	const found = tools.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`${name} is not among: ${tools.map((t) => t.name).join(", ")}`);
	return found;
}

beforeAll(async () => {
	// Importing the workflow module runs its `definePage()` — that IS the
	// registration, and it is why these tools need no app-specific wiring.
	await dashboard;
	tools = await inertiaMcpTools({ env: { NODE_ENV: "development" } as NodeJS.ProcessEnv, routes: () => [] });
});

describe("inertia.pages.list on examples/inertia-react", () => {
	it("serves all three read-only tools", () => {
		expect(tools.map((candidate) => candidate.name).sort()).toEqual([
			"inertia.page.get",
			"inertia.pages.list",
			"inertia.routes.list",
		]);
		for (const candidate of tools) expect(candidate.annotations.readOnlyHint).toBe(true);
	});

	it("contains Dashboard with `stats` marked defer", () => {
		const result = tool("inertia.pages.list").run({}) as {
			pages: { component: string; props: { key: string; mode: string; group?: string }[] }[];
		};
		const page = result.pages.find((candidate) => candidate.component === "Dashboard");
		expect(page, "the react example's Dashboard page is missing").toBeDefined();

		const stats = page?.props.find((prop) => prop.key === "stats");
		expect(stats?.mode).toBe("defer");
		expect(stats?.group).toBe("dashboard");

		// The other five modes the example declares, so a mode regression shows up.
		const modes = Object.fromEntries((page?.props ?? []).map((prop) => [prop.key, prop.mode]));
		expect(modes).toMatchObject({
			auth: "always",
			orders: "regular",
			notifications: "merge",
			plans: "once",
			posts: "scroll",
			activity: "scroll",
		});
	});
});

describe("inertia.page.get on examples/inertia-react", () => {
	it("returns a JSON Schema whose properties.orders is an array", () => {
		const result = tool("inertia.page.get").run({ component: "Dashboard" }) as {
			schema: { type: string; properties: Record<string, { type?: string; items?: { type?: string } }> };
		};

		expect(result.schema.type).toBe("object");
		expect(result.schema.properties.orders?.type).toBe("array");
		expect(result.schema.properties.orders?.items?.type).toBe("object");
	});
});
