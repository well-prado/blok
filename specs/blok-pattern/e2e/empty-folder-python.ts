// The "done when" of phase 4, run for real: a Python project from an empty folder, on a machine that has
// no Node. blokctl is its single-file build, the kernel is installed from its wheel (what would be uploaded
// to PyPI), and it ends with a FastAPI server that answers.
//
//   bun e2e/empty-folder-python.ts
//
// Bun is only what runs this script and builds the two things. Everything after "A new project" runs with
// a PATH that holds uv, Python and Pkl, and neither Node nor Bun.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const repo = join(import.meta.dirname, "..");
const work = realpathSync(mkdtempSync(join(tmpdir(), "blok-e2e-py-")));

/** Where a command is on this machine. */
function find(command: string): string {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		const candidate = join(dir, command);
		if (spawnSync("test", ["-x", candidate]).status === 0) return candidate;
	}
	throw new Error(`This run needs "${command}" on the PATH.`);
}

// A PATH with the three things a Python project needs and the system's own folders. No Node, no Bun.
const tools = join(work, "tools");
mkdirSync(tools);
for (const command of ["uv", "python3", "pkl"]) symlinkSync(find(command), join(tools, command));
const wheels = join(work, "wheels");
const clean: NodeJS.ProcessEnv = {
	...process.env,
	PATH: [tools, "/usr/bin", "/bin"].join(delimiter),
	UV_FIND_LINKS: wheels,
};
for (const key of Object.keys(clean)) if (key.startsWith("npm_") || key.startsWith("BUN_")) delete clean[key];

function sh(cwd: string, env: NodeJS.ProcessEnv, command: string, ...args: string[]): string {
	console.log(`$ ${[command, ...args].join(" ").replaceAll(work, "<work>").replaceAll(repo, "<repo>")}`);
	const run = spawnSync(command, args, { cwd, encoding: "utf8", env });
	const said = `${run.stdout}${run.stderr}`.trim();
	if (run.status !== 0) {
		console.log(said);
		throw new Error(`"${command} ${args.join(" ")}" failed with ${run.status}.`);
	}
	return said;
}
const show = (text: string) => console.log(text.replace(/^/gm, "  "));
const expect = (what: string, got: unknown, wanted: unknown) => {
	if (JSON.stringify(got) !== JSON.stringify(wanted)) {
		throw new Error(`${what}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(got)}.`);
	}
	console.log(`  ok: ${what}`);
};

const freePort = () =>
	new Promise<number>((done) => {
		const probe = createServer().listen(0, () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => done(port));
		});
	});

/** Starts the app the way its README says, and waits until it answers or stops. */
async function serve(cwd: string, test: (url: string) => Promise<void>): Promise<string> {
	const port = await freePort();
	console.log(`$ PORT=${port} uv run python app.py`);
	let output = "";
	const app: ChildProcess = spawn("uv", ["run", "python", "app.py"], { cwd, env: { ...clean, PORT: String(port) } });
	app.stdout?.on("data", (chunk) => {
		output += chunk;
	});
	app.stderr?.on("data", (chunk) => {
		output += chunk;
	});
	try {
		const url = `http://127.0.0.1:${port}`;
		const deadline = Date.now() + 30_000;
		for (;;) {
			if (app.exitCode !== null) return output;
			if (
				await fetch(`${url}/does-not-exist`).then(
					() => true,
					() => false,
				)
			)
				break;
			if (Date.now() > deadline) throw new Error(`The server did not start:\n${output}`);
			await new Promise((done) => setTimeout(done, 100));
		}
		await test(url);
		return output;
	} finally {
		app.kill("SIGTERM");
	}
}

const priceNode = `from pydantic import BaseModel, Field

from blok import Ctx, node
from ports import Ports

PRICES = {"book": 2500, "desk": 18000}


class Input(BaseModel):
    sku: str
    qty: int = Field(gt=0)


class Output(BaseModel):
    total_cents: int


def run(input: Input, ctx: Ctx[Ports]) -> Output:
    each = PRICES.get(input.sku)
    if each is None:
        raise ctx.fail("unknown_sku", f'There is no product "{input.sku}".')
    return Output(total_cents=each * input.qty)


price = node(
    id="shop/price@1",
    description="Prices a quantity of one product.",
    input=Input,
    output=Output,
    errors={"unknown_sku": "Nothing with that name is sold."},
    run=run,
)
`;
const priceTest = `import pytest

from blok import BlokError
from blok.testing import call, node_beside
from ports import memory_ports

price = node_beside(__file__)


def test_it_multiplies():
    assert call(price, {"sku": "book", "qty": 3}, ports=memory_ports()) == {"total_cents": 7500}


def test_it_refuses_a_product_it_does_not_know():
    with pytest.raises(BlokError) as refused:
        call(price, {"sku": "sofa", "qty": 1}, ports=memory_ports())
    assert refused.value.code == "unknown_sku"
`;
const priceWorkflow = `amends "blok/Workflow.pkl"

import "blok/shop.pkl"

name = "Price"
version = "1.0.0"

trigger {
  http = new {
    method = "POST"
    path = "/price"
    errors { ["unknown_sku"] = 404 }
  }
}

local price = new shop.Price {
  name = "price"
  inputs {
    sku = "\${request.body.sku}"
    qty = "\${request.body.qty}"
  }
}

steps {
  price
}

result {
  totalCents = price.outputs.total_cents
}
`;
const post = (url: string, body: unknown) =>
	fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function main() {
	console.log("\n== Build blokctl as one file, and the Python kernel as a wheel");
	const blokctl = join(work, "bin", "blokctl");
	sh(repo, process.env, "bun", "build", "--compile", "packages/cli/src/bin.ts", "--outfile", blokctl);
	sh(join(repo, "python"), process.env, "uv", "build", "--wheel", "--out-dir", wheels);
	show(readdirSync(wheels).join("\n"));
	for (const gone of ["node", "bun", "npm", "npx"]) {
		expect(`there is no ${gone} from here on`, spawnSync("which", [gone], { env: clean }).status === 0, false);
	}
	const ctl = (cwd: string, ...args: string[]) => sh(cwd, clean, blokctl, ...args);

	// ------------------------------------------------------------------------------------------
	console.log("\n== A new project, from an empty folder");
	const empty = join(work, "empty");
	mkdirSync(empty);
	show(ctl(empty, "init", "my-api", "--lang", "python"));
	const api = join(empty, "my-api");
	sh(api, clean, "uv", "sync");
	show(ctl(api, "doctor"));

	show(ctl(api, "new", "node", "shop/price"));
	writeFileSync(join(api, "nodes/shop/price/v1/node.py"), priceNode);
	writeFileSync(join(api, "nodes/shop/price/v1/test_node.py"), priceTest);
	show(ctl(api, "new", "workflow", "price"));
	writeFileSync(join(api, "workflows/price.pkl"), priceWorkflow);
	// A workflow on a schedule, so the server that starts below also starts its schedules.
	ctl(api, "new", "workflow", "nightly", "--trigger", "cron");
	writeFileSync(
		join(api, "workflows/nightly.pkl"),
		priceWorkflow
			.replace('name = "Price"', 'name = "Nightly"')
			.replace(
				/trigger \{[\s\S]*?\n\}\n/,
				'trigger {\n  cron = new { schedule = "0 2 * * *"; body { sku = "book"; qty = 1 } }\n}\n',
			),
	);
	show(ctl(api, "check"));
	show(ctl(api, "check", "shop/price"));
	show(ctl(api, "list"));
	show(ctl(api, "build"));
	const described = JSON.parse(readFileSync(join(api, ".blok/openapi.json"), "utf8"));
	expect(
		"the build describes the two routes as OpenAPI",
		[described.openapi, Object.keys(described.paths)],
		["3.1.0", ["/hello", "/price"]],
	);
	const manifest = JSON.parse(readFileSync(join(api, ".blok/app.json"), "utf8"));
	expect(
		"the build says which contracts it was checked against",
		[manifest.language, Object.keys(manifest.nodes), Object.keys(manifest.workflows)],
		["python", ["hello/greet@1", "shop/price@1"], ["workflows/hello@1", "workflows/nightly@1", "workflows/price@1"]],
	);
	expect(
		"run with no input, the scheduled workflow gets its schedule's body",
		JSON.parse(ctl(api, "run", "nightly", "--json")).output,
		{ totalCents: 2500 },
	);
	expect(
		"one node runs from the command line",
		JSON.parse(ctl(api, "run", "shop/price", "--input", '{"sku":"desk","qty":2}', "--json")).output,
		{ total_cents: 36000 },
	);
	// The scaffolded test for the sample node and the two written above, with the project's own test runner.
	const tests = sh(api, clean, "uv", "run", "pytest", "-q");
	expect("the node tests pass", /\b3 passed\b/.test(tests), true);
	expect("every node's tests pass through blokctl too", /3 node tests pass/.test(ctl(api, "check", "--tests")), true);

	await serve(api, async (url) => {
		const hello = await fetch(`${url}/hello?name=Ada`);
		expect("GET /hello?name=Ada", [hello.status, (await hello.json()).message], [200, "Hello, Ada!"]);
		const price = await post(`${url}/price`, { sku: "desk", qty: 2 });
		expect("POST /price", [price.status, await price.json()], [200, { totalCents: 36000 }]);
		const unknown = await post(`${url}/price`, { sku: "sofa", qty: 1 });
		expect(
			"an error code becomes the status the workflow gave it",
			[unknown.status, (await unknown.json()).error],
			[404, "unknown_sku"],
		);
		const missing = await post(`${url}/price`, { sku: "desk" });
		expect(
			"a request missing a field is a 400",
			[missing.status, (await missing.json()).message],
			[400, "The request is missing: body.qty."],
		);
		const text = await post(`${url}/price`, { sku: "desk", qty: "2" });
		expect("text where a number is asked for is a 400", [text.status, (await text.json()).node], [400, "shop/price@1"]);
		const broken = await fetch(`${url}/price`, { method: "POST", body: '{"sku":' });
		expect("a body that is not JSON is a 400", broken.status, 400);
	});

	// ------------------------------------------------------------------------------------------
	console.log("\n== A contract that changed after the build");
	writeFileSync(join(api, "nodes/shop/price/v1/node.py"), priceNode.replaceAll("total_cents", "total"));
	const refused = await serve(api, async () => {
		throw new Error("The app started on a build that was checked against another contract.");
	});
	expect(
		"the app refuses to start, and says which node and what to do",
		[
			refused.includes('The app does not match what "blokctl build" checked'),
			refused.includes("shop/price@1 takes, answers with or fails with something else than when the app was built."),
			refused.includes('Run "blokctl build" again.'),
		],
		[true, true, true],
	);
	const wiring = spawnSync(blokctl, ["check"], { cwd: api, env: clean, encoding: "utf8" });
	expect(
		"and blokctl check says what the change broke",
		[wiring.status, /"price" has no field "total_cents"|total_cents/.test(`${wiring.stdout}${wiring.stderr}`)],
		[1, true],
	);

	console.log("\nAll of it worked in Python, with no Node on the PATH.");
}

try {
	await main();
} finally {
	rmSync(work, { recursive: true, force: true });
}
