import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blokctl, cleanUp, folder, install, project, write } from "./helpers.ts";

afterAll(cleanUp);
// Every test runs the real command several times, each in its own process.
setDefaultTimeout(60_000);

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
const json = (dir: string, file: string) => JSON.parse(read(dir, file));

// ---- init --------------------------------------------------------------------------------

test("init <name> makes a project that checks and builds as it is", () => {
	const dir = project("shop");
	expect(readdirSync(dir).sort()).toEqual([
		".gitignore",
		"AGENTS.md",
		"app.ts",
		"blok.ts",
		"node_modules",
		"nodes",
		"package.json",
		"ports",
		"tsconfig.json",
		"workflows",
	]);
	expect(json(dir, "package.json")).toMatchObject({
		name: "shop",
		imports: { "#blok": "./blok.ts", "#ports": "./ports/index.ts" },
		dependencies: { "@blokjs/kernel": "3.0.0-next.0" },
		devDependencies: { blokctl: "3.0.0-next.0" },
	});

	expect(blokctl(dir, ["check"])).toEqual({ exit: 0, out: "1 node and 1 workflow line up.", err: "" });
	expect(blokctl(dir, ["build"])).toEqual({ exit: 0, out: "Built 1 workflow into .blok/workflows.", err: "" });
	// What production loads is plain JSON, with the typed references turned into placeholders.
	expect(json(dir, ".blok/workflows/hello.json")).toEqual({
		name: "Hello",
		description: "Greets whoever asks.",
		version: "1.0.0",
		trigger: { http: { method: "GET", path: "/hello" } },
		steps: [{ name: "greeting", node: "hello/greet@1", inputs: { name: "${request.query.name}" } }],
		result: { message: "${greeting.message}", at: "${greeting.at}" },
	});
	// The generated Pkl is not for git.
	expect(read(dir, "workflows/blok/.gitignore")).toBe("*\n");
	expect(read(dir, ".gitignore")).toContain(".blok/");
});

test("init refuses a folder that already has things in it", () => {
	const parent = folder();
	write(parent, "shop/notes.txt", "mine");
	const again = blokctl(parent, ["init", "shop"]);
	expect(again.exit).toBe(1);
	expect(again.err).toBe('"shop" already exists and is not empty. Run "blokctl init" inside it to add Blok to it.');
	expect(readdirSync(join(parent, "shop"))).toEqual(["notes.txt"]);
});

test("init inside an existing app adds what is missing, overwrites nothing, and is safe to run twice", () => {
	const dir = folder();
	const manifest = {
		name: "legacy-api",
		type: "module",
		scripts: { start: "node server.js" },
		imports: { "#db": "./db.js" },
	};
	write(dir, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
	write(dir, "AGENTS.md", "# Our rules\n\nUse tabs.\n");
	write(dir, "src/ports/index.ts", "export interface Ports { db: unknown }\n");
	const first = blokctl(dir, ["init", "--dir", "src", "--json"]);
	expect(first.exit).toBe(0);
	expect(JSON.parse(first.out).added).toEqual(["src/blok.ts", "AGENTS.md", ".gitignore", "package.json (imports)"]);
	// Their ports file and their own settings are untouched.
	expect(read(dir, "src/ports/index.ts")).toBe("export interface Ports { db: unknown }\n");
	expect(json(dir, "package.json")).toEqual({
		...manifest,
		imports: { "#blok": "./src/blok.ts", "#ports": "./src/ports/index.ts", "#db": "./db.js" },
		blok: { dir: "src" },
	});
	// It keeps the two-space indentation the file had.
	expect(read(dir, "package.json")).toStartWith('{\n  "name": "legacy-api",\n  "type": "module",');
	const rules = read(dir, "AGENTS.md");
	expect(rules.startsWith("# Our rules\n\nUse tabs.\n\n<!-- blok:start -->")).toBe(true);
	expect(rules).toContain("src/nodes/<module>/<node>/v<N>/node.ts");
	expect(existsSync(join(dir, "app.ts"))).toBe(false);
	expect(read(dir, ".gitignore")).toBe("src/.blok/\n");

	const second = blokctl(dir, ["init", "--dir", "src"]);
	expect(second.out).toStartWith("Everything was already in place.");
	expect(read(dir, "AGENTS.md")).toBe(rules);

	// With "blok.dir" in package.json, the other commands find the folder without --dir.
	install(dir);
	expect(blokctl(dir, ["new", "node", "users/find"]).out).toContain("src/nodes/users/find/v1/node.ts");
});

test("init needs a package.json, or a name for a new project", () => {
	const none = blokctl(folder(), ["init"]);
	expect(none).toMatchObject({
		exit: 1,
		err: 'There is no package.json here. Run "blokctl init <name>" to start a new project.',
	});
});

// ---- new ---------------------------------------------------------------------------------

test("new node writes a contract with no logic: workflows can use it, and nothing ships until it is filled in", () => {
	const dir = project();
	const made = blokctl(dir, ["new", "node", "billing/charge-card"]);
	expect(made.out).toStartWith(
		"Created billing/charge-card@1:\n  nodes/billing/charge-card/v1/node.ts\n  nodes/billing/charge-card/v1/node.test.ts",
	);
	expect(read(dir, "nodes/billing/charge-card/v1/node.ts")).toContain('id: "billing/charge-card@1"');

	expect(blokctl(dir, ["check"]).out).toBe(
		"2 nodes and 1 workflow line up.\n1 node is still empty: billing/charge-card@1.",
	);
	const refused = blokctl(dir, ["build"]);
	expect(refused.exit).toBe(1);
	expect(refused.err).toBe(
		'1 node is still empty: billing/charge-card@1.\nNothing was built. An empty node answers "not_implemented", so it cannot be shipped.',
	);
	expect(existsSync(join(dir, ".blok"))).toBe(false);
	// While developing, a half-built app is exactly what you want to run.
	expect(blokctl(dir, ["build", "--allow-empty"]).exit).toBe(0);

	// Fill it in, and it ships.
	write(
		dir,
		"nodes/billing/charge-card/v1/node.ts",
		`import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "billing/charge-card@1",
	input: z.object({ token: z.string() }),
	output: z.object({ receiptId: z.string() }),
	run: ({ token }) => ({ receiptId: \`rc_\${token}\` }),
});
`,
	);
	expect(blokctl(dir, ["build"])).toMatchObject({ exit: 0, out: "Built 1 workflow into .blok/workflows." });

	const twice = blokctl(dir, ["new", "node", "billing/charge-card"]);
	expect(twice.err).toBe(
		'billing/charge-card already exists. To change what it takes or answers with, run "blokctl new version billing/charge-card".',
	);
	expect(blokctl(dir, ["new", "node", "Billing"]).err).toContain('"Billing" is not a node name.');
});

test("new version copies the newest version and leaves the old one alone", () => {
	const dir = project();
	const before = read(dir, "nodes/hello/greet/v1/node.ts");
	const made = blokctl(dir, ["new", "version", "hello/greet"]);
	expect(made.out).toStartWith("Created hello/greet@2 in nodes/hello/greet/v2, as a copy of version 1.");
	expect(read(dir, "nodes/hello/greet/v1/node.ts")).toBe(before);
	expect(read(dir, "nodes/hello/greet/v2/node.ts")).toBe(before.replace("hello/greet@1", "hello/greet@2"));
	expect(read(dir, "nodes/hello/greet/v2/node.test.ts")).toContain("hello/greet@2 answers");

	// Both are loaded, the workflow still points at version 1, and version 2 has its own typed step.
	expect(blokctl(dir, ["check"]).out).toBe("2 nodes and 1 workflow line up.");
	expect(read(dir, "workflows/blok/hello.pkl")).toContain("class GreetV2 extends Workflow.Step");
	expect(blokctl(dir, ["new", "version", "hello/greet"]).out).toContain("Created hello/greet@3");
	expect(blokctl(dir, ["new", "version", "hello/nobody"]).err).toBe(
		'hello/nobody does not exist yet. Run "blokctl new node hello/nobody".',
	);
});

test("new workflow starts a Pkl file, and check says what it still needs", () => {
	const dir = project();
	expect(blokctl(dir, ["new", "workflow", "place-order"]).out).toStartWith("Created workflows/place-order.pkl.");
	const check = blokctl(dir, ["check"]);
	expect(check.exit).toBe(1);
	expect(check.err).toBe("1 problem:\n- workflows/place-order@1: It has no steps yet. Add at least one.");
	expect(blokctl(dir, ["new", "workflow", "place-order", "--json"]).err).toBe(
		"workflows/place-order.pkl already exists.",
	);
});

// ---- check -------------------------------------------------------------------------------

test("check reports a Pkl type mistake with the file and line, and a wiring mistake as a sentence", () => {
	const dir = project();
	const hello = read(dir, "workflows/hello.pkl");

	// A number where the node takes text: Pkl refuses the file.
	writeFileSync(join(dir, "workflows/hello.pkl"), hello.replace('name = "${request.query.name}"', "name = 42"));
	const typed = blokctl(dir, ["check"]);
	expect(typed.exit).toBe(1);
	expect(typed.err).toMatch(/^1 problem:\n- –– Pkl Error ––[\s\S]*hello\.pkl, line \d+\)/);

	// A field the step does not have: Pkl refuses that too, because the reference is typed.
	writeFileSync(join(dir, "workflows/hello.pkl"), hello.replace("greeting.outputs.at", "greeting.outputs.time"));
	expect(blokctl(dir, ["check"]).err).toContain("Cannot find property `time`");

	// A placeholder is text to Pkl. The check reads the node contracts and catches what Pkl cannot.
	writeFileSync(join(dir, "workflows/hello.pkl"), hello.replace("at = greeting.outputs.at", 'at = "${greeting.att}"'));
	const wired = blokctl(dir, ["check", "--json"]);
	expect(wired.exit).toBe(1);
	expect(JSON.parse(wired.out)).toEqual({
		ok: false,
		nodes: 1,
		workflows: 1,
		empty: [],
		problems: ['workflows/hello@1: result.at: "greeting" has no field "att". It has: message, at.'],
	});
	// A failed check never leaves a build behind.
	expect(blokctl(dir, ["build"]).exit).toBe(1);
	expect(existsSync(join(dir, ".blok"))).toBe(false);
});

test("a node whose id disagrees with its folder stops the check", () => {
	const dir = project();
	write(dir, "nodes/hello/wave/v1/node.ts", read(dir, "nodes/hello/greet/v1/node.ts"));
	expect(blokctl(dir, ["check"]).err).toBe(
		'1 problem:\n- hello/wave/v1/node.ts declares "hello/greet@1", but its path says "hello/wave@1".',
	);
});

// ---- workflows written as JSON -----------------------------------------------------------

test("a workflow can be JSON written by hand: same check, same build, and no Pkl involved", () => {
	const dir = project();
	const hello = json(blokctlBuilt(dir), "hello.json");

	// The same workflow in both forms is a mistake.
	write(dir, "workflows/hello.json", JSON.stringify(hello));
	expect(blokctl(dir, ["check"]).err).toBe(
		"1 problem:\n- hello.json and hello.pkl are the same workflow written twice. Keep one.",
	);
	rmSync(join(dir, "workflows/hello.pkl"));
	expect(blokctl(dir, ["new", "workflow", "hello"]).err).toBe("workflows/hello.json already exists.");

	// From here the project is JSON only, and there is no `pkl` command to be found.
	const noPkl = { PATH: "/usr/bin:/bin", BLOK_OFFLINE: "1" };
	blokctl(dir, ["new", "workflow", "bye", "--json"]);
	expect(json(dir, "workflows/bye.json")).toEqual({
		$schema: "./blok/workflow.schema.json",
		name: "Bye",
		version: "1.0.0",
		trigger: { http: { method: "POST", path: "/bye" } },
		steps: [],
	});
	const bye = { ...hello, name: "Bye", trigger: { http: { method: "GET", path: "/bye" } } };
	write(dir, "workflows/bye.json", JSON.stringify({ $schema: "./blok/workflow.schema.json", ...bye }));
	expect(blokctl(dir, ["build"], noPkl)).toEqual({ exit: 0, out: "Built 2 workflows into .blok/workflows.", err: "" });
	expect(readdirSync(join(dir, ".blok/workflows"))).toEqual(["bye.json", "hello.json"]);
	// The schema the files point at is put beside them, so an editor completes and underlines JSON too.
	expect(json(dir, "workflows/blok/workflow.schema.json").title).toBe("Blok workflow");

	// A mistake in the structure is reported as a sentence that says where.
	const broken = structuredClone(bye);
	broken.steps[0].type = "module";
	broken.steps.push({ name: "extra" });
	broken.trigger.http.method = "FETCH";
	write(dir, "workflows/bye.json", JSON.stringify(broken));
	expect(blokctl(dir, ["check"], noPkl).err).toBe(
		[
			"3 problems:",
			"- bye.json: trigger.http.method must be one of: GET, POST, PUT, PATCH, DELETE.",
			'- bye.json: steps.0 has an unknown key "type".',
			'- bye.json: steps.1 is missing "node".',
		].join("\n"),
	);

	// And the wiring is checked against the node contracts exactly as it is for Pkl.
	write(dir, "workflows/bye.json", JSON.stringify({ ...bye, steps: [{ ...bye.steps[0], inputs: { nam: "x" } }] }));
	expect(blokctl(dir, ["check"], noPkl).err).toBe(
		'1 problem:\n- workflows/bye@1: step "greeting": "hello/greet@1" has no input "nam". It takes: name.',
	);

	// A project that does have Pkl files, on a machine with no Pkl and no way to fetch it, says what to do.
	write(dir, "workflows/again.pkl", 'amends "blok/Workflow.pkl"\nname = "Again"\n');
	expect(blokctl(dir, ["check"], noPkl).err).toContain(
		"Workflows are written in Pkl, and no `pkl` command was found. BLOK_OFFLINE is set, so it was not downloaded.",
	);
});

/** Builds, and returns the folder the JSON was written to. */
function blokctlBuilt(dir: string): string {
	const built = blokctl(dir, ["build"]);
	if (built.exit !== 0) throw new Error(built.err);
	return join(dir, ".blok", "workflows");
}

// ---- a workflow used as a step -----------------------------------------------------------

const outer = (inputs: string) => `amends "blok/Workflow.pkl"

import "blok/workflows.pkl"

name = "Welcome"
version = "1.0.0"
trigger { http = new { method = "GET"; path = "/welcome" } }

local hello = new workflows.Hello {
  name = "hello"
  inputs { ${inputs} }
}

steps { hello }

result { text = hello.outputs.message }
`;

test("a workflow used as a step gets a typed step of its own, from a cold start", () => {
	const dir = project();
	// `hello` reads its name from the query string, which a caller cannot set. Make it read the body instead.
	const hello = read(dir, "workflows/hello.pkl").replace("request.query.name", "request.body.name");
	writeFileSync(join(dir, "workflows/hello.pkl"), hello);
	write(dir, "workflows/welcome.pkl", outer('name = "${request.query.who}"'));

	// Nothing is generated yet, and welcome.pkl needs a class that only exists once hello.pkl has been read.
	expect(existsSync(join(dir, "workflows/blok"))).toBe(false);
	expect(blokctl(dir, ["check"])).toMatchObject({ exit: 0, out: "1 node and 2 workflows line up." });
	const generated = read(dir, "workflows/blok/workflows.pkl");
	expect(generated).toContain(
		'class Hello extends Workflow.Step {\n  node = "workflows/hello@1"\n  inputs: HelloInputs',
	);
	expect(generated).toContain("class HelloInputs {\n  name: (Workflow.StringIn)?\n}");
	expect(generated).toContain('message: Workflow.StringRef = new { path = "\\(step).message" }');
	expect(json(blokctlBuilt(dir), "welcome.json").steps).toEqual([
		{ name: "hello", node: "workflows/hello@1", inputs: { name: "${request.query.who}" } },
	]);

	// The inputs are typed like a node's: a number where the workflow reads text is refused by Pkl...
	write(dir, "workflows/welcome.pkl", outer("name = 42"));
	expect(blokctl(dir, ["check"]).err).toMatch(/Pkl Error[\s\S]*welcome\.pkl/);
	// ...an input the workflow never reads is refused too...
	write(dir, "workflows/welcome.pkl", outer('nam = "Ada"'));
	expect(blokctl(dir, ["check"]).err).toContain("Cannot find property `nam`");
	// ...and so is a workflow that does not exist.
	write(dir, "workflows/welcome.pkl", outer('name = "Ada"').replace("workflows.Hello", "workflows.Helo"));
	expect(blokctl(dir, ["check"]).err).toMatch(/Cannot find (type|class|property) .*Helo/);
});

// ---- how a node is named in a workflow ---------------------------------------------------

const greetAs = (id: string) => (source: string) => source.replace("hello/greet@1", id);

test("a node is named by its module, so another node with the same name changes nothing", () => {
	const dir = project();
	blokctl(dir, ["check"]);
	const before = read(dir, "workflows/blok/hello.pkl");

	// A second `greet` in another module, and one in a module whose name has a hyphen.
	const greet = read(dir, "nodes/hello/greet/v1/node.ts");
	write(dir, "nodes/users/greet/v1/node.ts", greetAs("users/greet@1")(greet));
	write(dir, "nodes/user-accounts/greet/v1/node.ts", greetAs("user-accounts/greet@1")(greet));
	expect(blokctl(dir, ["check"])).toEqual({ exit: 0, out: "3 nodes and 1 workflow line up.", err: "" });

	// `hello.Greet` is the same file byte for byte, and the workflow that uses it was not touched.
	expect(read(dir, "workflows/blok/hello.pkl")).toBe(before);
	expect(readdirSync(join(dir, "workflows/blok")).sort()).toEqual([
		".gitignore",
		"Workflow.pkl",
		"hello.pkl",
		"userAccounts.pkl",
		"users.pkl",
		"workflows.pkl",
	]);
	expect(read(dir, "workflows/blok/userAccounts.pkl")).toStartWith(
		"/// A typed step for every node in nodes/user-accounts/. GENERATED from the node contracts. Do not edit.\nmodule blok.userAccounts\n",
	);

	// Both new ones are usable from a workflow, each under its own module.
	write(
		dir,
		"workflows/hello.pkl",
		read(dir, "workflows/hello.pkl")
			.replace(
				'import "blok/hello.pkl"',
				'import "blok/hello.pkl"\nimport "blok/userAccounts.pkl"\nimport "blok/users.pkl"',
			)
			.replace(
				"steps {\n  greeting\n}",
				'steps {\n  greeting\n  new users.Greet { name = "again" }\n  new userAccounts.Greet { name = "third" }\n}',
			),
	);
	expect(blokctl(dir, ["build"]).exit).toBe(0);
	expect(json(dir, ".blok/workflows/hello.json").steps.map((step: { node: string }) => step.node)).toEqual([
		"hello/greet@1",
		"users/greet@1",
		"user-accounts/greet@1",
	]);
});

test("the generated folder never keeps a file for a module that is gone", () => {
	const dir = project();
	write(dir, "nodes/users/find/v1/node.ts", greetAs("users/find@1")(read(dir, "nodes/hello/greet/v1/node.ts")));
	// A file an older version of this tool wrote, and one for a module nested in another.
	write(dir, "workflows/blok/nodes.pkl", "module blok.nodes\n");
	write(dir, "nodes/shop/cart/add/v1/node.ts", greetAs("shop/cart/add@1")(read(dir, "nodes/hello/greet/v1/node.ts")));
	expect(blokctl(dir, ["check"]).exit).toBe(0);
	const generated = () => readdirSync(join(dir, "workflows/blok"), { recursive: true, encoding: "utf8" }).sort();
	expect(generated()).toEqual([
		".gitignore",
		"Workflow.pkl",
		"hello.pkl",
		"shop",
		"shop/cart.pkl",
		"users.pkl",
		"workflows.pkl",
	]);
	// A module inside a module finds the schema one folder up.
	expect(read(dir, "workflows/blok/shop/cart.pkl")).toContain('module blok.shop.cart\n\nimport "../Workflow.pkl"');

	rmSync(join(dir, "nodes/users"), { recursive: true });
	expect(blokctl(dir, ["check"]).exit).toBe(0);
	expect(generated()).not.toContain("users.pkl");
});

test("names that cannot work are refused with the reason", () => {
	const dir = project();
	const greet = read(dir, "nodes/hello/greet/v1/node.ts");
	write(dir, "nodes/workflows/greet/v1/node.ts", greetAs("workflows/greet@1")(greet));
	expect(blokctl(dir, ["check"]).err).toBe(
		'1 problem:\n- workflows/greet@1: a node module cannot be called "workflows". That name belongs to the workflows.',
	);
	rmSync(join(dir, "nodes/workflows"), { recursive: true });

	// On a Mac or on Windows these two would be one generated file.
	write(dir, "nodes/user-accounts/greet/v1/node.ts", greetAs("user-accounts/greet@1")(greet));
	write(dir, "nodes/useraccounts/greet/v1/node.ts", greetAs("useraccounts/greet@1")(greet));
	expect(blokctl(dir, ["check"]).err).toBe(
		"1 problem:\n- The node modules behind userAccounts.pkl and useraccounts.pkl differ only by a hyphen. Rename one.",
	);
	rmSync(join(dir, "nodes/useraccounts"), { recursive: true });
	rmSync(join(dir, "nodes/user-accounts"), { recursive: true });

	// A step variable with the name of an imported module: Pkl says which line.
	const hello = read(dir, "workflows/hello.pkl");
	write(dir, "workflows/hello.pkl", hello.replaceAll("greeting", "hello"));
	expect(blokctl(dir, ["check"]).err).toMatch(/Duplicate definition of member `hello`[\s\S]*hello\.pkl, line 16\)/);
});

// ---- list --------------------------------------------------------------------------------

test("list is the catalog: what each node and workflow takes and answers with", () => {
	const dir = project();
	blokctl(dir, ["new", "node", "users/find"]);
	expect(blokctl(dir, ["list"]).out).toBe(
		[
			"Nodes (2)",
			"  hello/greet@1  as hello.Greet",
			"    Builds a greeting for a name.",
			"    takes:   name?: string",
			"    answers: message: string, at: string",
			"  users/find@1  as users.Find  (empty)",
			"    Say in one sentence what this node does.",
			"    takes:   nothing",
			"    answers: nothing",
			"",
			"Workflows (1)",
			"  workflows/hello@1  as workflows.Hello  GET /hello",
			"    Greets whoever asks.",
			"    reads query: name?: string",
			"    answers: message: string, at: string",
		].join("\n"),
	);
	const data = JSON.parse(blokctl(dir, ["list", "--json"]).out);
	expect(data.nodes.map((node: { id: string; implemented: boolean }) => [node.id, node.implemented])).toEqual([
		["hello/greet@1", true],
		["users/find@1", false],
	]);
	expect(data.nodes[0].input).toMatchObject({ type: "object", properties: { name: { type: "string" } } });
	// The name to write in a workflow, and the file to import for it, so an agent never has to guess either.
	expect(data.nodes[1].pkl).toEqual({ import: "blok/users.pkl", step: "users.Find" });
	expect(data.workflows[0]).toMatchObject({
		id: "workflows/hello@1",
		file: "hello.pkl",
		pkl: { import: "blok/workflows.pkl", step: "workflows.Hello" },
	});
});

// ---- the command itself ------------------------------------------------------------------

test("a wrong command says so and exits with 2", () => {
	const dir = folder();
	expect(blokctl(dir, ["deploy"])).toMatchObject({
		exit: 2,
		err: expect.stringContaining('"deploy" is not a command.'),
	});
	expect(blokctl(dir, ["new", "node"]).exit).toBe(2);
	expect(blokctl(dir, ["--version"]).out).toBe("3.0.0-next.0");
	expect(blokctl(dir, []).out).toContain("blokctl init [name]");
});
