// The commands of the AI loop: design locks the contracts, status is the work queue,
// `check <node>` is the gate for one node, and `mcp` hands the same facts to an agent as tools.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CLI, NODE, blokctl, cleanUp, folder, installTypeScript, project, write } from "./helpers.ts";

afterAll(cleanUp);
// Every test runs the real command several times, each in its own process.
setDefaultTimeout(60_000);

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
// The node tests run with Node's own runner here, whatever started this test file.
const withNode = { npm_config_user_agent: "" };

const priceContract = `import { todo } from "@blokjs/kernel";
import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "shop/price@1",
	description: "Prices a quantity of one product.",
	input: z.object({ sku: z.string().describe("The product's code."), qty: z.number().int().positive() }),
	output: z.object({ totalCents: z.number().int() }),
	errors: ["unknown_sku"],
	run: todo,
});
`;
const priceLogic = (each = "{ book: 2500, desk: 18000 }") =>
	priceContract.replace('import { todo } from "@blokjs/kernel";\n', "").replace(
		"run: todo,",
		`run({ sku, qty }, { fail }) {
		const each = (${each} as Record<string, number>)[sku];
		if (each === undefined) throw fail("unknown_sku", "There is no such product.");
		return { totalCents: each * qty };
	},`,
	);
const priceTest = `import assert from "node:assert/strict";
import { test } from "node:test";
import { runtime } from "#blok";
import { ports } from "#ports";
import price from "./node.ts";

test("shop/price@1 multiplies, and refuses a product it does not know", async () => {
	const { call } = runtime({ ports });
	assert.deepEqual(await call(price, { sku: "book", qty: 3 }), { totalCents: 7500 });
	await assert.rejects(call(price, { sku: "sofa", qty: 1 }), { code: "unknown_sku" });
});
`;
const priceWorkflow = `amends "blok/Workflow.pkl"

import "blok/shop.pkl"

name = "Price"
version = "1.0.0"
trigger { http = new { method = "POST"; path = "/price"; errors { ["unknown_sku"] = 404 } } }

local price = new shop.Price {
  name = "price"
  inputs { sku = "\${request.body.sku}"; qty = "\${request.body.qty}" }
}

steps { price }

result { totalCents = price.outputs.totalCents }
`;

/** A project as the design pass leaves it: one written node, one designed and still empty, and a workflow over it. */
function designed(): string {
	const dir = project();
	blokctl(dir, ["new", "node", "shop/price"]);
	write(dir, "nodes/shop/price/v1/node.ts", priceContract);
	write(dir, "nodes/shop/price/v1/node.test.ts", priceTest);
	write(dir, "workflows/price.pkl", priceWorkflow);
	return dir;
}

test("status is the work queue: what is empty, what has no test, and what is not locked", () => {
	const dir = designed();
	expect(blokctl(dir, ["status"]).out).toBe(
		[
			"1 of 2 nodes is still empty:",
			"  shop/price@1  nodes/shop/price/v1  used by price",
			'2 nodes have no contract.json, so nothing stops their contract from changing. Run "blokctl lock" when the contracts are settled.',
		].join("\n"),
	);
	const data = JSON.parse(blokctl(dir, ["status", "--json"]).out);
	expect(data).toMatchObject({
		ok: true,
		total: 2,
		empty: ["shop/price@1"],
		untested: [],
		unlocked: ["hello/greet@1", "shop/price@1"],
	});
	expect(data.nodes[1]).toEqual({
		id: "shop/price@1",
		folder: "nodes/shop/price/v1",
		pkl: { import: "blok/shop.pkl", step: "shop.Price" },
		empty: true,
		locked: false,
		tests: ["nodes/shop/price/v1/node.test.ts"],
		usedBy: [{ workflow: "workflows/price@1", step: "price" }],
	});
});

test("lock writes down what a node promised, and check refuses a node that no longer keeps it", () => {
	const dir = designed();
	expect(blokctl(dir, ["lock"]).out).toStartWith("Locked 2 nodes: contract.json is now beside each of them, in nodes.");
	expect(JSON.parse(read(dir, "nodes/shop/price/v1/contract.json"))).toMatchObject({
		id: "shop/price@1",
		input: { type: "object", required: ["sku", "qty"] },
		output: { type: "object", required: ["totalCents"] },
		errors: ["unknown_sku"],
	});
	expect(blokctl(dir, ["status"]).out).toEndWith("Every node's contract is locked.");
	expect(blokctl(dir, ["lock"]).out).toBe("Every node was already locked. Nothing was written.");

	// Writing the logic changes no part of the contract, so the check stays green.
	write(dir, "nodes/shop/price/v1/node.ts", priceLogic());
	expect(blokctl(dir, ["check"]).out).toBe("2 nodes and 2 workflows line up.");

	// An agent that makes its job easier by loosening the contract is caught, and told what to do instead.
	write(
		dir,
		"nodes/shop/price/v1/node.ts",
		priceLogic().replace("qty: z.number().int().positive()", "qty: z.number()"),
	);
	const drifted = blokctl(dir, ["check"]);
	expect(drifted.exit).toBe(1);
	expect(drifted.err).toBe(
		'1 problem:\n- shop/price@1: its input is not what contract.json promises. To change a contract, run "blokctl new version shop/price" and change the copy. If this node is still being designed, run "blokctl lock shop/price@1".',
	);
	write(
		dir,
		"nodes/shop/price/v1/node.ts",
		priceLogic().replace('errors: ["unknown_sku"]', 'errors: ["unknown_sku", "sold_out"]'),
	);
	expect(blokctl(dir, ["check"]).err).toContain("shop/price@1: its errors are not what contract.json promises.");

	// While it is still being designed, locking it again is how the contract changes on purpose.
	expect(blokctl(dir, ["lock", "shop/price@1"]).out).toStartWith("Locked shop/price@1: contract.json is now beside it");
	// The new contract is checked against everything that uses it: the workflow now has an error with no status.
	expect(blokctl(dir, ["check"]).err).toBe(
		'1 problem:\n- workflows/price@1: step "price" can fail with "sold_out", and the trigger gives that no status, so a caller would get a 500. Give "sold_out" a status in the trigger\'s errors.',
	);
	write(
		dir,
		"workflows/price.pkl",
		priceWorkflow.replace('["unknown_sku"] = 404', '["unknown_sku"] = 404; ["sold_out"] = 409'),
	);
	expect(blokctl(dir, ["check"]).exit).toBe(0);

	// A new version is a new contract in the making, so it starts unlocked.
	blokctl(dir, ["new", "version", "shop/price"]);
	expect(existsSync(join(dir, "nodes/shop/price/v2/contract.json"))).toBe(false);
	expect(existsSync(join(dir, "nodes/shop/price/v1/contract.json"))).toBe(true);
	expect(blokctl(dir, ["lock", "shop/nothing@1"]).err).toBe(
		'shop/nothing@1 is not a node. Run "blokctl list" to see the nodes.',
	);
});

test("check <node> is the gate for one node: written, tested, passing, and still the contract that was locked", () => {
	const dir = designed();
	blokctl(dir, ["lock"]);

	// Designed and nothing more: the test states what it must do, and it fails.
	const empty = blokctl(dir, ["check", "shop/price"], withNode);
	expect(empty.exit).toBe(1);
	expect(empty.err).toStartWith(
		'2 problems:\n- shop/price@1 is still empty. Replace `run: todo` with its logic.\n- shop/price@1: its tests fail. This is what "node --test" printed:',
	);

	// Logic that is wrong: the runner's own output says where.
	write(dir, "nodes/shop/price/v1/node.ts", priceLogic("{ book: 1, desk: 18000 }"));
	const wrong = blokctl(dir, ["check", "shop/price@1"], withNode);
	expect(wrong.exit).toBe(1);
	expect(wrong.err).toStartWith("1 problem:\n- shop/price@1: its tests fail.");
	expect(wrong.err).toMatch(/totalCents: 3|7500/);

	// Logic that is right.
	write(dir, "nodes/shop/price/v1/node.ts", priceLogic());
	expect(blokctl(dir, ["check", "shop/price"], withNode)).toEqual({
		exit: 0,
		out: "2 nodes and 2 workflows line up.\nshop/price@1 is done: its logic is written, its 1 test passes and its contract is what contract.json promises.",
		err: "",
	});
	const data = JSON.parse(blokctl(dir, ["check", "shop/price", "--json"], withNode).out);
	expect(data).toMatchObject({
		ok: true,
		id: "shop/price@1",
		tests: { command: "node --test", passed: true, count: 1 },
	});

	// With the project's TypeScript compiler installed, the gate also checks the node's types.
	// Most test runners run TypeScript without checking it, so this error passes every test above.
	installTypeScript(dir);
	write(
		dir,
		"nodes/shop/price/v1/node.ts",
		priceLogic().replace(
			"return { totalCents: each * qty };",
			"const label: number = sku;\n\t\tvoid label;\n\t\treturn { totalCents: each * qty };",
		),
	);
	const mistyped = blokctl(dir, ["check", "shop/price"], withNode);
	expect(mistyped.exit).toBe(1);
	expect(mistyped.err).toMatch(
		/^1 problem:\n- shop\/price@1: its code has type errors:\nnodes\/shop\/price\/v1\/node\.ts\(\d+,\d+\): error TS2322: Type 'string' is not assignable to type 'number'\.$/,
	);
	write(dir, "nodes/shop/price/v1/node.ts", priceLogic());
	expect(blokctl(dir, ["check", "shop/price"], withNode).out).toBe(
		"2 nodes and 2 workflows line up.\nshop/price@1 is done: its logic is written, its 1 test passes, its types check and its contract is what contract.json promises.",
	);

	// The project can name its own test command.
	const manifest = JSON.parse(read(dir, "package.json"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ ...manifest, blok: { test: "bun test" } }, null, "\t"));
	expect(JSON.parse(blokctl(dir, ["check", "shop/price", "--json"], withNode).out).tests).toEqual({
		command: "bun test",
		passed: true,
		count: 1,
	});
	writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, "\t"));

	// A node with no test is not done, and neither is one that does not exist.
	rmSync(join(dir, "nodes/shop/price/v1/node.test.ts"));
	expect(blokctl(dir, ["check", "shop/price"], withNode).err).toBe(
		"1 problem:\n- shop/price@1 has no test. Write one beside it, in nodes/shop/price/v1/node.test.ts.",
	);
	expect(blokctl(dir, ["check", "shop/nothing"], withNode).err).toBe(
		'1 problem:\n- shop/nothing is not a node. Run "blokctl list" to see the nodes.',
	);
	// The whole project's tests, in one go.
	expect(blokctl(dir, ["check", "--tests"], withNode).out).toBe(
		"2 nodes and 2 workflows line up.\n1 node test passes, and the types check.",
	);
});

test("show is one node or one workflow in full", () => {
	const dir = designed();
	blokctl(dir, ["lock", "shop/price@1"]);
	expect(blokctl(dir, ["show", "shop/price"]).out).toBe(
		[
			"shop/price@1  (empty)",
			"  Prices a quantity of one product.",
			"  folder:   nodes/shop/price/v1",
			'  as a step: shop.Price, after import "blok/shop.pkl"',
			"  contract: locked by contract.json",
			"  takes:",
			"    sku: string  (The product's code.)",
			"    qty: integer",
			"  answers:",
			"    totalCents: integer",
			"  errors:",
			"    unknown_sku",
			"  tests:    nodes/shop/price/v1/node.test.ts",
			'  used by:  workflows/price@1 (step "price")',
		].join("\n"),
	);
	expect(blokctl(dir, ["show", "price"]).out).toBe(
		[
			"workflows/price@1",
			"  started by: POST /price",
			"  file:      workflows/price.pkl",
			'  as a step: workflows.Price, after import "blok/workflows.pkl"',
			"  reads body:",
			"    sku: string  (The product's code.)",
			"    qty: integer",
			"  answers:",
			"    totalCents: integer",
			"  steps:",
			"    price: shop/price@1",
			"  statuses:  unknown_sku is 404",
		].join("\n"),
	);
	const data = JSON.parse(blokctl(dir, ["show", "shop/price@1", "--json"]).out);
	expect(data).toMatchObject({
		kind: "node",
		id: "shop/price@1",
		implemented: false,
		locked: true,
		errors: ["unknown_sku"],
	});
	expect(data.input.properties.qty).toMatchObject({ type: "integer" });
	expect(blokctl(dir, ["show", "nothing"])).toMatchObject({
		exit: 1,
		err: '"nothing" is not a node or a workflow. Run "blokctl list" to see them.',
	});
});

test("the two briefs: one for designing an app, one for writing a single node", () => {
	const dir = designed();
	blokctl(dir, ["lock"]);
	const design = blokctl(dir, ["prompt", "design"]).out;
	expect(design).toStartWith(
		"You are doing the DESIGN PASS of a Blok backend. You write contracts and wiring. You write no logic.",
	);
	expect(design).toContain("`blokctl lock` has been run after the last contract change");

	const build = blokctl(dir, ["prompt", "build", "shop/price"]).out;
	expect(build).toStartWith(
		"You are writing ONE node of a Blok backend: shop/price@1.\n\nWhat it does: Prices a quantity of one product.",
	);
	expect(build).toContain("Your folder is nodes/shop/price/v1/. Change files in that folder and nowhere else.");
	expect(build).toContain("They are locked by contract.json, and the check refuses a node that differs from it.");
	// The contract is in the brief itself, so the agent does not have to go and find it.
	expect(build).toContain('"required": [\n    "sku",\n    "qty"\n  ]');
	// Without the noise the schema library adds: the largest safe integer is not a rule of this app.
	expect(build).toContain('"qty": {\n      "type": "integer",\n      "exclusiveMinimum": 0\n    }');
	expect(build).not.toContain("$schema");
	expect(build).toContain(
		'How it may fail: throw one of these with `throw fail("<code>", "<message>")`. No other code is allowed.\n\n- unknown_sku',
	);
	expect(build).toContain("Make the test in nodes/shop/price/v1/node.test.ts pass.");
	expect(build).toContain(
		"Run `npx blokctl check shop/price@1` from the folder that holds package.json. You are done when it says the node is done.",
	);
	expect(JSON.parse(blokctl(dir, ["prompt", "build", "shop/price", "--json"]).out)).toMatchObject({
		id: "shop/price@1",
		folder: "nodes/shop/price/v1",
	});
	expect(blokctl(dir, ["prompt", "build", "shop/nothing"]).err).toBe(
		'shop/nothing is not a node. Run "blokctl status" to see the nodes that are still empty.',
	);
	expect(blokctl(dir, ["prompt"]).exit).toBe(2);
});

test("run executes one node or one workflow here, and shows what ran", () => {
	const dir = designed();
	// A node that is only designed already refuses what its contract refuses, before it says it is not written.
	expect(blokctl(dir, ["run", "shop/price", "--input", '{"sku":"desk"}']).err).toStartWith(
		'shop/price@1 failed with "invalid_input" at shop/price@1:',
	);
	expect(blokctl(dir, ["run", "shop/price", "--input", '{"sku":"desk","qty":2}']).err).toStartWith(
		'shop/price@1 failed with "not_implemented" at shop/price@1: shop/price@1 is not implemented yet.',
	);
	write(dir, "nodes/shop/price/v1/node.ts", priceLogic());

	const node = JSON.parse(blokctl(dir, ["run", "shop/price", "--input", '{"sku":"desk","qty":2}', "--json"]).out);
	expect(node).toMatchObject({ ok: true, id: "shop/price@1", output: { totalCents: 36000 } });
	expect(node.spans).toMatchObject([{ id: "shop/price@1", ok: true }]);

	// A workflow is given its request, and answers to its file name, its id, and its id without the version.
	for (const name of ["workflows/price@1", "workflows/price"]) {
		expect(
			JSON.parse(blokctl(dir, ["run", name, "--input", '{"body":{"sku":"desk","qty":1}}', "--json"]).out).output,
		).toEqual({
			totalCents: 18000,
		});
	}
	const text = blokctl(dir, ["run", "price", "--input", '{"body":{"sku":"book","qty":3}}']).out;
	expect(text).toStartWith('{\n  "totalCents": 7500\n}\n\nWhat ran:\n  ok  shop/price@1 (step "price")');

	const failed = blokctl(dir, ["run", "price", "--input", '{"body":{"sku":"sofa","qty":1}}']);
	expect(failed.exit).toBe(1);
	expect(failed.err).toStartWith(
		'workflows/price@1 failed with "unknown_sku" at shop/price@1: There is no such product.',
	);
	expect(blokctl(dir, ["run", "price", "--input", "{not json"]).err).toStartWith("--input is not valid JSON:");
	expect(blokctl(dir, ["run", "nothing"]).err).toBe(
		'"nothing" is not a node or a workflow. Run "blokctl list" to see them.',
	);

	// Other ports can be named, and a file with none is said plainly.
	write(dir, "fixed.ts", 'export const ports = { clock: { now: () => new Date("2030-05-05T00:00:00Z") } };\n');
	const hello = JSON.parse(blokctl(dir, ["run", "hello", "--ports", "fixed.ts", "--json"]).out);
	expect(hello.output).toEqual({ message: "Hello, world!", at: "2030-05-05T00:00:00.000Z" });
	write(dir, "empty.ts", "export const nothing = 1;\n");
	expect(blokctl(dir, ["run", "hello", "--ports", "empty.ts"]).err).toContain("exports no `ports`.");
});

test("doctor says what is in place and what is not", () => {
	const dir = project();
	const fine = blokctl(dir, ["doctor"]);
	expect(fine.exit).toBe(0);
	expect(fine.out).toContain("ok      Project: package.json maps #blok and #ports.");
	expect(fine.out).toContain("ok      @blokjs/kernel: Installed, 3.0.0-next.0, the same version as blokctl.");
	expect(fine.out).toEndWith("Nothing here stops blokctl from working.");

	const nowhere = blokctl(folder(), ["doctor", "--json"], {
		PATH: "/usr/bin:/bin",
		BLOK_OFFLINE: "1",
		BLOK_CACHE_DIR: folder(),
	});
	expect(nowhere.exit).toBe(1);
	const findings: Array<{ what: string; state: string }> = JSON.parse(nowhere.out).findings;
	expect(findings.filter((finding) => finding.state === "problem").map((finding) => finding.what)).toEqual([
		"Pkl",
		"Project",
	]);
});

test("mcp serves the same facts as tools, to the official MCP client", async () => {
	const dir = designed();
	const transport = new StdioClientTransport({ command: NODE, args: [CLI, "mcp"], cwd: dir });
	const client = new Client({ name: "blok-test", version: "1.0.0" });
	await client.connect(transport);
	try {
		expect(client.getServerVersion()).toEqual({ name: "blokctl", version: "3.0.0-next.0" });
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).toEqual([
			"blok_list",
			"blok_show",
			"blok_status",
			"blok_check",
			"blok_prompt",
		]);

		const text = async (name: string, args: Record<string, unknown> = {}) => {
			const result = (await client.callTool({ name, arguments: args })) as {
				content: Array<{ type: string; text: string }>;
				isError?: boolean;
			};
			return { text: result.content[0].text, isError: result.isError ?? false };
		};
		const listed = JSON.parse((await text("blok_list")).text);
		expect(listed.nodes.map((node: { id: string }) => node.id)).toEqual(["hello/greet@1", "shop/price@1"]);
		expect(JSON.parse((await text("blok_status")).text).empty).toEqual(["shop/price@1"]);
		expect(JSON.parse((await text("blok_show", { id: "shop/price" })).text).pkl).toEqual({
			import: "blok/shop.pkl",
			step: "shop.Price",
		});
		expect((await text("blok_prompt", { id: "shop/price" })).text).toStartWith(
			"You are writing ONE node of a Blok backend: shop/price@1.",
		);

		// A check that finds problems is an answer to read, not a broken tool.
		const gate = await text("blok_check", { id: "shop/price" });
		expect(gate.isError).toBe(false);
		expect(JSON.parse(gate.text)).toMatchObject({ ok: false, id: "shop/price@1" });

		// It reads the project fresh on every call: a change on disk is seen by the next one.
		write(dir, "nodes/shop/price/v1/node.ts", priceLogic());
		expect(JSON.parse((await text("blok_status")).text).empty).toEqual([]);

		expect(await text("blok_show")).toEqual({ text: 'blok_show needs "id".', isError: true });
		expect(client.callTool({ name: "blok_delete_everything", arguments: {} })).rejects.toThrow(
			'There is no tool called "blok_delete_everything".',
		);
	} finally {
		await client.close();
	}
}, 60_000);
