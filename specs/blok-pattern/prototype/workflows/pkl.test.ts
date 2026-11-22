// Workflows are written in Pkl. These tests show what Pkl itself refuses, before the runner sees anything.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Workflow, checkWorkflow, contract } from "@blokjs/kernel";
import { analyze, locate } from "blokctl";

const here = import.meta.dirname;
const root = join(here, "..");
// Regenerates workflows/blok/, the typed steps these tests write against.
const { nodes: units } = await analyze(locate(root));

const blok = pathToFileURL(join(here, "blok")).href;
const evaluate = (file: string) => spawnSync("pkl", ["eval", "-f", "json", file], { encoding: "utf8" });

// A node is written by its module and name, and each module is one generated file.
const imports = ["billing", "orders", "shipping", "storage"]
	.map((module) => `import "${blok}/${module}.pkl"`)
	.join("\n");

/** Evaluates a throwaway workflow file. */
function evaluateSource(body: string) {
	const dir = mkdtempSync(join(tmpdir(), "blok-pkl-"));
	try {
		const file = join(dir, "broken.pkl");
		writeFileSync(file, `amends "${blok}/Workflow.pkl"\n${imports}\nname = "Demo"\n${body}\n`);
		const out = evaluate(file);
		return { exit: out.status, json: out.stdout, error: out.stderr, dir };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
const problemsOf = (workflow: Workflow) =>
	checkWorkflow(workflow, (id) => {
		const unit = units.get(id);
		return unit ? { input: contract(unit).input as object, output: contract(unit).output as object } : undefined;
	}).problems;

const charge = (inputs: string) => `steps { new billing.ChargeCard { name = "charge"; inputs { ${inputs} } } }`;
const order =
	'local order = new orders.ValidateOrder { name = "order"; inputs { customerId = "c_1"; items = "${request.body.items}" } }';

test("Pkl refuses these mistakes when the file is evaluated, in either writing style", () => {
	const mistakes: [what: string, body: string, error: string][] = [
		[
			"an input the node does not take",
			charge('orderID = "o"; amountCents = 1; token = "t"'),
			"Cannot find property `orderID` in object of type `blok.billing#ChargeCardInputs`",
		],
		[
			"a missing input",
			charge('orderId = "o"; amountCents = 1'),
			"Tried to read property `token` but its value is undefined",
		],
		[
			"a literal of the wrong type",
			charge('orderId = "o"; amountCents = "12"; token = "t"'),
			"Expected value of type `Int|IntRef|AnyRef|Placeholder`",
		],
		[
			"a literal outside the enum",
			'steps { new shipping.Book { name = "b"; inputs { orderId = "o"; lane = "courrier" } } }',
			'"courier"|"post"|"hold"',
		],
		[
			"a node that does not exist",
			'steps { new billing.ChargeCrd { name = "c" } }',
			"Cannot find type `ChargeCrd` in module `blok.billing`",
		],
		["a misspelled key on a step", 'steps { new storage.KvList { nam = "list" } }', "Cannot find property `nam`"],
		[
			"a condition that is not one",
			'steps { new storage.KvList { name = "list"; `if` = "price > 100" } }',
			"Type constraint",
		],
		[
			"an HTTP status that is not an error",
			'trigger { http = new { method = "POST"; path = "/x"; errors { ["declined"] = 200 } } }',
			"isBetween(400, 599)",
		],
	];
	for (const [what, body, error] of mistakes) {
		const out = evaluateSource(body);
		expect(`${what}: exit ${out.exit}`).toBe(`${what}: exit 1`);
		expect(out.error).toContain(error);
	}
});

test("with typed references, Pkl also refuses a wrong field and a value of the wrong kind", () => {
	const mistakes: [what: string, body: string, error: string][] = [
		[
			"a result field that does not exist",
			`${order}\nsteps { order; new orders.PriceOrder { name = "price"; inputs { items = order.outputs.itemz } } }`,
			"Cannot find property `itemz` in object of type `blok.orders#ValidateOrderOutputs`",
		],
		[
			"a string result wired into a number input",
			`${order}\nsteps { order; ${charge('orderId = order.outputs.orderId; amountCents = order.outputs.orderId; token = "t"').slice("steps { ".length)}`,
			"but got a different `blok.Workflow#StringRef`",
		],
		[
			"a greater-than comparison on a string",
			`${order}\nsteps { order; new orders.FlagVip { name = "flag"; \`if\` = order.outputs.orderId.gt(5); inputs { customerId = "c" } } }`,
			"Cannot find method `gt` in class `blok.Workflow#StringRef`",
		],
	];
	for (const [what, body, error] of mistakes) {
		const out = evaluateSource(body);
		expect(`${what}: exit ${out.exit}`).toBe(`${what}: exit 1`);
		expect(out.error).toContain(error);
	}
});

test("a typed reference and a placeholder string produce the same workflow", () => {
	const typed = evaluateSource(
		`${order}\nlocal price = new orders.PriceOrder { name = "price"; inputs { items = order.outputs.items } }\nlocal flag = new orders.FlagVip { name = "flag"; \`if\` = price.outputs.totalCents.gt(10000); inputs { customerId = order.outputs.customerId } }\nsteps { order; price; flag }\nresult { total = price.outputs.totalCents; all = order.value }`,
	);
	const strings = evaluateSource(
		`${order}\nsteps {\n  order\n  new orders.PriceOrder { name = "price"; inputs { items = "\${order.items}" } }\n  new orders.FlagVip { name = "flag"; \`if\` = "\${price.totalCents} > 10000"; inputs { customerId = "\${order.customerId}" } }\n}\nresult { total = "\${price.totalCents}"; all = "\${order}" }`,
	);
	expect(typed.error).toBe("");
	expect(strings.error).toBe("");
	expect(JSON.parse(typed.json)).toEqual(JSON.parse(strings.json));
});

test("what Pkl cannot see, the runner's load-time check still catches", () => {
	// A placeholder is text to Pkl, so a wrong one passes it.
	const text = evaluateSource(
		`${order}\nsteps { order; new orders.PriceOrder { name = "price"; inputs { items = "\${order.itemz}" } } }`,
	);
	expect(text.exit).toBe(0);
	expect(problemsOf(JSON.parse(text.json) as Workflow)).toEqual([
		'step "price", input "items": "order" has no field "itemz". It has: orderId, customerId, items.',
	]);

	// Typed references know a step's fields, but not whether the step ran.
	const skipped = evaluateSource(
		`${order}\nlocal flag = new orders.FlagVip { name = "flag"; \`if\` = "\${request.body.vip} == true"; inputs { customerId = order.outputs.customerId } }\nsteps { order; flag }\nresult { flagged = flag.outputs.flagged }`,
	);
	expect(skipped.exit).toBe(0);
	expect(problemsOf(JSON.parse(skipped.json) as Workflow)).toEqual([
		'result.flagged: ${flag.flagged} reads step "flag", which may not have run at this point.',
	]);
});

test("a workflow file that does not evaluate is reported with Pkl's message and the file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "blok-pkl-"));
	try {
		mkdirSync(join(dir, "workflows"));
		writeFileSync(
			join(dir, "workflows", "broken.pkl"),
			`amends "blok/Workflow.pkl"\nimport "blok/billing.pkl"\nname = "Broken"\n${charge('orderId = "o"')}\n`,
		);
		// This project's nodes, and a workflows folder that holds only the broken file.
		const { problems, workflows } = await analyze({ ...locate(dir), nodes: join(root, "nodes") });
		expect(workflows).toEqual([]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/Tried to read property `amountCents`[\s\S]*broken\.pkl/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
