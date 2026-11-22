// Phase 3 from the author's side: triggers written in Pkl and in JSON, the OpenAPI file, and a new
// project on each of the three servers.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { Validator } from "@seriousme/openapi-schema-validator";
import { NODE, blokctl, cleanUp, project, write } from "./helpers.ts";

afterAll(cleanUp);
setDefaultTimeout(60_000);

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
const json = (dir: string, file: string) => JSON.parse(read(dir, file));

const restock = `import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "stock/restock@1",
	description: "Orders more of a product for a region.",
	input: z.object({
		region: z.string().describe("Where to deliver, such as eu."),
		limit: z.number().int().min(1).default(10),
		dryRun: z.boolean().default(false),
	}),
	output: z.object({ ordered: z.number().int(), region: z.string() }),
	errors: { unknown_region: "The shop does not sell in that region." },
	run({ region, limit }, { fail }) {
		if (region === "mars") throw fail("unknown_region", "Nothing is sold on Mars.");
		return { ordered: limit, region };
	},
});
`;

const workflow = (name: string, trigger: string, inputs: string, more = "") => `amends "blok/Workflow.pkl"

import "blok/stock.pkl"

name = "${name}"
description = "Orders more stock for a region."
version = "1.0.0"

trigger {
${trigger}
}

local restock = new stock.Restock {
  name = "restock"
  inputs { ${inputs} }
}

steps {
${more}  restock
}
`;
const fromBody = 'region = "${request.body.region}"; limit = "${request.body.limit}"';

/** A project with one node and one workflow per way of starting it. */
function shop(): string {
	const dir = project();
	rmSync(join(dir, "workflows/hello.pkl"));
	rmSync(join(dir, "nodes/hello"), { recursive: true });
	write(dir, "nodes/stock/restock/v1/node.ts", restock);
	write(
		dir,
		"workflows/nightly.pkl",
		workflow(
			"Nightly",
			'  cron = new {\n    schedule = "30 2 * * mon-fri"\n    timezone = "Europe/Lisbon"\n    body { region = "eu"; limit = 25 }\n  }',
			fromBody,
		),
	);
	write(
		dir,
		"workflows/on-low-stock.pkl",
		workflow("On low stock", '  queue = new { name = "stock.low"; concurrency = 4 }', fromBody),
	);
	write(dir, "workflows/restock-tool.pkl", workflow("Restock tool", '  mcp = new { tool = "restock" }', fromBody));
	write(
		dir,
		"workflows/supplier-hook.pkl",
		workflow(
			"Supplier hook",
			[
				"  http = new {",
				'    method = "POST"',
				'    path = "/hooks/suppliers/:supplier"',
				"    status = 202",
				'    errors { ["unknown_region"] = 422; ["supplier_blocked"] = 403 }',
				'    signature = new { scheme = "standard"; secret = "SUPPLIER_WEBHOOK_SECRET" }',
				"  }",
			].join("\n"),
			`${fromBody}; dryRun = "\${request.query.dryRun}"`,
			'  new Fail { fail = "supplier_blocked"; `if` = "${request.params.supplier} == \'acme\'"; message = "That supplier is blocked." }\n',
		),
	);
	return dir;
}

test("every trigger is written in Pkl, comes out in the built JSON, and shows in list, show and check", () => {
	const dir = shop();
	expect(blokctl(dir, ["check"])).toEqual({
		exit: 0,
		out: "1 node and 4 workflows line up.\nBesides HTTP there are 1 schedule, 1 queue and 1 tool. They run only if the app calls startCron, startQueues and blokMcp where it starts.",
		err: "",
	});
	expect(blokctl(dir, ["build"]).out).toBe(
		"Built 4 workflows into .blok/workflows.\nThe API is described in .blok/openapi.json.",
	);
	expect(json(dir, ".blok/workflows/nightly.json").trigger).toEqual({
		cron: { schedule: "30 2 * * mon-fri", timezone: "Europe/Lisbon", body: { region: "eu", limit: 25 } },
	});
	expect(json(dir, ".blok/workflows/on-low-stock.json").trigger).toEqual({
		queue: { name: "stock.low", concurrency: 4 },
	});
	expect(json(dir, ".blok/workflows/restock-tool.json").trigger).toEqual({ mcp: { tool: "restock" } });
	expect(json(dir, ".blok/workflows/supplier-hook.json").trigger).toEqual({
		http: {
			method: "POST",
			path: "/hooks/suppliers/:supplier",
			status: 202,
			errors: { unknown_region: 422, supplier_blocked: 403 },
			signature: { scheme: "standard", secret: "SUPPLIER_WEBHOOK_SECRET" },
		},
	});

	const listed = blokctl(dir, ["list"]).out;
	expect(listed).toContain("workflows/nightly@1  as workflows.Nightly  cron 30 2 * * mon-fri (Europe/Lisbon)");
	expect(listed).toContain("workflows/on-low-stock@1  as workflows.OnLowStock  queue stock.low");
	expect(listed).toContain("workflows/restock-tool@1  as workflows.RestockTool  tool restock");
	expect(listed).toContain(
		"workflows/supplier-hook@1  as workflows.SupplierHook  POST /hooks/suppliers/:supplier (signed, standard)",
	);
	expect(blokctl(dir, ["show", "nightly"]).out).toContain("  started by: cron 30 2 * * mon-fri (Europe/Lisbon)");
	expect(JSON.parse(blokctl(dir, ["show", "restock-tool", "--json"]).out).startedBy).toEqual(["tool restock"]);

	// Run from the terminal with no input, a scheduled workflow gets what its schedule gives it.
	expect(JSON.parse(blokctl(dir, ["run", "nightly", "--json"]).out).output).toEqual({ ordered: 25, region: "eu" });
	expect(
		JSON.parse(blokctl(dir, ["run", "nightly", "--input", '{"body":{"region":"us"}}', "--json"]).out).output,
	).toEqual({
		ordered: 10,
		region: "us",
	});
});

test("Pkl refuses a trigger that is written wrong, and the check refuses one that cannot work", () => {
	const dir = shop();
	const nightly = read(dir, "workflows/nightly.pkl");
	const hook = read(dir, "workflows/supplier-hook.pkl");
	const tried = (file: string, source: string) => {
		write(dir, file, source);
		return blokctl(dir, ["check"]).err;
	};

	// A secret written into the workflow instead of the name of the variable that holds it.
	expect(tried("workflows/supplier-hook.pkl", hook.replace("SUPPLIER_WEBHOOK_SECRET", "whsec_abc123"))).toMatch(
		/Type constraint[\s\S]*violated[\s\S]*whsec_abc123/,
	);
	expect(tried("workflows/supplier-hook.pkl", hook.replace('scheme = "standard"', 'scheme = "md5"'))).toMatch(
		/Expected value of type[\s\S]*"md5"/,
	);
	write(dir, "workflows/supplier-hook.pkl", hook);
	expect(
		tried(
			"workflows/on-low-stock.pkl",
			read(dir, "workflows/on-low-stock.pkl").replace("concurrency = 4", "concurrency = 0"),
		),
	).toMatch(/Type constraint `this >= 1` violated/);
	rmSync(join(dir, "workflows/on-low-stock.pkl"));

	// These read fine as Pkl. What is wrong with them is what they mean.
	expect(tried("workflows/nightly.pkl", nightly.replace("30 2 * * mon-fri", "30 25 * * mon-fri"))).toBe(
		'1 problem:\n- workflows/nightly@1: The schedule "30 25 * * mon-fri" cannot be read: hour 25 is outside 0-23.',
	);
	expect(tried("workflows/nightly.pkl", nightly.replace('region = "eu"; ', ""))).toBe(
		"1 problem:\n- workflows/nightly@1: The schedule starts it with a body that lacks: region. Write it in the cron trigger's body.",
	);
	expect(tried("workflows/nightly.pkl", nightly.replace("Europe/Lisbon", "Lisbon"))).toBe(
		'1 problem:\n- workflows/nightly@1: "Lisbon" is not a time zone. Use a name such as "Europe/Lisbon", or leave it out for UTC.',
	);
	write(dir, "workflows/nightly.pkl", nightly);
	// Two agents each adding a workflow can pick the same route.
	write(
		dir,
		"workflows/supplier-hook-2.pkl",
		hook.replace(":supplier", ":id").replaceAll("request.params.supplier", "request.params.id"),
	);
	expect(blokctl(dir, ["check"]).err).toBe(
		"1 problem:\n- workflows/supplier-hook-2@1 and workflows/supplier-hook@1 both answer POST /hooks/suppliers/:supplier. A route belongs to one workflow.",
	);
});

test("the same triggers written as JSON by hand pass the same check", () => {
	const dir = shop();
	blokctl(dir, ["build"]);
	for (const name of ["nightly", "on-low-stock", "restock-tool", "supplier-hook"]) {
		const built = json(dir, `.blok/workflows/${name}.json`);
		rmSync(join(dir, `workflows/${name}.pkl`));
		write(dir, `workflows/${name}.json`, JSON.stringify(built));
	}
	expect(blokctl(dir, ["check"]).out).toStartWith("1 node and 4 workflows line up.");

	const nightly = json(dir, "workflows/nightly.json");
	nightly.trigger.cron.every = "night";
	nightly.trigger.queue = { concurrency: 0 };
	nightly.trigger.mcp = { tool: "restock now" };
	write(dir, "workflows/nightly.json", JSON.stringify(nightly));
	const hook = json(dir, "workflows/supplier-hook.json");
	hook.trigger.http.signature = { scheme: "md5", secret: "whsec_abc123" };
	write(dir, "workflows/supplier-hook.json", JSON.stringify(hook));
	expect(blokctl(dir, ["check"]).err.split("\n").sort()).toEqual(
		[
			"6 problems:",
			'- nightly.json: trigger.cron has an unknown key "every".',
			'- nightly.json: trigger.queue is missing "name".',
			"- nightly.json: trigger.queue.concurrency must be >= 1.",
			'- nightly.json: trigger.mcp.tool must match pattern "^[A-Za-z0-9_-]{1,64}$".',
			"- supplier-hook.json: trigger.http.signature.scheme must be one of: standard, stripe, github, hmac.",
			'- supplier-hook.json: trigger.http.signature.secret must match pattern "^[A-Z][A-Z0-9_]*$".',
		].sort(),
	);
});

test("new workflow --trigger writes each kind of trigger, in Pkl and in JSON", () => {
	const dir = project();
	const unfinished = (id: string, more: string[] = []) =>
		[
			`${more.length + 1} ${more.length === 0 ? "problem" : "problems"}:`,
			`- ${id}: It has no steps yet. Add at least one.`,
			...more,
		].join("\n");
	for (const kind of ["cron", "queue", "mcp"]) {
		const made = blokctl(dir, ["new", "workflow", `by-${kind}`, "--trigger", kind]);
		expect(made).toMatchObject({
			exit: 0,
			out: `Created workflows/by-${kind}.pkl. It has no steps yet, so "blokctl check" will ask for some.`,
		});
		// What is missing is what the author has to write, and nothing else.
		expect(blokctl(dir, ["check"]).err).toBe(
			unfinished(
				`workflows/by-${kind}@1`,
				kind === "mcp"
					? [
							"- workflows/by-mcp@1: It is a tool for agents and has no description, and the description is how an agent chooses a tool. Give the workflow a description.",
						]
					: [],
			),
		);
		rmSync(join(dir, `workflows/by-${kind}.pkl`));
		blokctl(dir, ["new", "workflow", `by-${kind}`, "--trigger", kind, "--json"]);
		expect(Object.keys(json(dir, `workflows/by-${kind}.json`).trigger)).toEqual([kind]);
		rmSync(join(dir, `workflows/by-${kind}.json`));
	}
	expect(read(dir, "workflows/blok/Workflow.pkl")).toContain("class Cron {");
	const wrong = blokctl(dir, ["new", "workflow", "by-mail", "--trigger", "mail"]);
	expect(wrong).toMatchObject({ exit: 1, err: '"mail" cannot start a workflow. Use http, cron, queue or mcp.' });
	expect(existsSync(join(dir, "workflows/by-mail.pkl"))).toBe(false);
});

// ---- OpenAPI -----------------------------------------------------------------------------

test("openapi describes every route from the contracts, and a validator accepts the document", async () => {
	const dir = shop();
	write(
		dir,
		"workflows/restock.pkl",
		workflow(
			"Restock",
			'  http = new { method = "POST"; path = "/regions/:region/restock"; status = 201; errors { ["unknown_region"] = 404 } }',
			'region = "${request.params.region}"; limit = "${request.body.limit}"; dryRun = "${request.query.dryRun}"',
		),
	);
	const printed = blokctl(dir, ["openapi"]);
	expect(printed.exit).toBe(0);
	const document = JSON.parse(printed.out);
	const checked = await new Validator().validate(structuredClone(document));
	expect(checked.errors ?? []).toEqual([]);
	expect(checked.valid).toBe(true);

	expect(document.openapi).toBe("3.1.0");
	expect(document.info).toEqual({ title: "shop", version: "0.0.0" });
	// Only the workflows with a route are in it.
	expect(Object.keys(document.paths)).toEqual(["/regions/{region}/restock", "/hooks/suppliers/{supplier}"]);

	const restockRoute = document.paths["/regions/{region}/restock"].post;
	expect(restockRoute).toMatchObject({
		operationId: "restock",
		summary: "Restock",
		description: "Orders more stock for a region.",
		parameters: [
			// The description a node gives a field travels all the way to the document.
			{
				name: "region",
				in: "path",
				required: true,
				schema: { type: "string", description: "Where to deliver, such as eu." },
			},
			{ name: "dryRun", in: "query", required: false, schema: { type: "boolean" } },
		],
		requestBody: {
			required: false,
			content: {
				"application/json": { schema: { type: "object", properties: { limit: { type: "integer", minimum: 1 } } } },
			},
		},
	});
	expect(Object.keys(restockRoute.responses)).toEqual(["201", "400", "404", "500"]);
	expect(restockRoute.responses["201"].content["application/json"].schema).toMatchObject({
		type: "object",
		properties: { ordered: { type: "integer" }, region: { type: "string" } },
		required: ["ordered", "region"],
	});
	// An error is described by the sentence its node wrote for it.
	expect(restockRoute.responses["404"]).toEqual({
		description: "unknown_region: The shop does not sell in that region.",
		content: {
			"application/json": {
				schema: {
					type: "object",
					required: ["error", "message"],
					properties: {
						error: { enum: ["unknown_region"] },
						message: { type: "string" },
						node: { type: "string", description: "The node or workflow that refused." },
					},
				},
			},
		},
	});
	expect(restockRoute.responses["400"].description).toBe(
		"invalid_input: The request lacks something, or has something of the wrong kind.",
	);

	// A signed route says which headers carry the signature, and that it can answer 401.
	const hook = document.paths["/hooks/suppliers/{supplier}"].post;
	expect(
		hook.parameters.map(
			(one: { name: string; in: string; required: boolean }) => `${one.in} ${one.name}${one.required ? "" : "?"}`,
		),
	).toEqual([
		"path supplier",
		"query dryRun?",
		"header webhook-id",
		"header webhook-timestamp",
		"header webhook-signature",
	]);
	expect(Object.keys(hook.responses)).toEqual(["202", "400", "401", "403", "422", "500"]);
	// A refusal written in the workflow is described by its own message.
	expect(hook.responses["403"].description).toBe("supplier_blocked: That supplier is blocked.");
	expect(hook.requestBody.required).toBe(true);
	expect(JSON.stringify(document)).not.toContain("$schema");

	// `build` writes the same document beside the workflows.
	blokctl(dir, ["build"]);
	expect(json(dir, ".blok/openapi.json")).toEqual(document);
	// With no route left there is nothing to describe, and the file goes.
	rmSync(join(dir, "workflows/restock.pkl"));
	rmSync(join(dir, "workflows/supplier-hook.pkl"));
	expect(blokctl(dir, ["build"]).out).toBe("Built 3 workflows into .blok/workflows.");
	expect(existsSync(join(dir, ".blok/openapi.json"))).toBe(false);
	expect(JSON.parse(blokctl(dir, ["openapi"]).out).paths).toEqual({});

	// A project that does not line up has no description yet.
	write(dir, "workflows/nightly.pkl", read(dir, "workflows/nightly.pkl").replace("30 2", "99 2"));
	const refused = blokctl(dir, ["openapi"]);
	expect(refused.exit).toBe(1);
	expect(refused.err).toStartWith(
		"This project has problems, so there is nothing to describe yet:\n- workflows/nightly@1:",
	);
});

// ---- the three servers -------------------------------------------------------------------

const freePort = () =>
	new Promise<number>((done) => {
		const probe = createServer().listen(0, () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => done(port));
		});
	});

for (const [server, more] of [
	["fastify", []],
	["hono", ["hono", "@hono/node-server"]],
	["express", ["express"]],
] as const) {
	test(`init --server ${server} makes a project whose server answers, on a route and on a schedule`, async () => {
		const dir = project("api", { server, more: [...more] });
		expect(Object.keys(json(dir, "package.json").dependencies)).toEqual([
			"@blokjs/kernel",
			...(server === "hono" ? ["hono", "@hono/node-server"] : [server]),
			"zod",
		]);
		expect(read(dir, "app.ts")).toContain(`from "@blokjs/kernel/${server}"`);
		// A job for every minute, so that the server shows its schedules started without the test waiting for one.
		write(
			dir,
			"workflows/tick.pkl",
			read(dir, "workflows/hello.pkl")
				.replace('name = "Hello"', 'name = "Tick"')
				.replace(/trigger \{[\s\S]*?\n\}\n/, 'trigger {\n  cron = new { schedule = "* * * * *" }\n}\n')
				.replace('inputs { name = "${request.query.name}" }', 'inputs { name = "the clock" }'),
		);
		expect(blokctl(dir, ["build"]).exit).toBe(0);

		const port = await freePort();
		let output = "";
		const app = spawn(NODE, ["app.ts"], { cwd: dir, env: { ...process.env, PORT: String(port) } });
		app.stdout.on("data", (chunk) => {
			output += chunk;
		});
		app.stderr.on("data", (chunk) => {
			output += chunk;
		});
		try {
			let answer: Response | undefined;
			for (let i = 0; i < 100 && !answer; i++) {
				answer = await fetch(`http://127.0.0.1:${port}/hello?name=Ada`).catch(() => undefined);
				if (!answer) await new Promise((done) => setTimeout(done, 100));
			}
			if (!answer) throw new Error(`The ${server} app did not start. It printed:\n${output}`);
			expect(answer.status).toBe(200);
			expect(await answer.json()).toMatchObject({ message: "Hello, Ada!" });
			const missing = await fetch(`http://127.0.0.1:${port}/nowhere`);
			expect(missing.status).toBe(404);
		} finally {
			app.kill("SIGKILL");
		}
	});
}

test("init says which servers it knows, and gives an existing app the lines for the server it has", () => {
	const dir = project();
	const wrong = blokctl(dir, ["init", "other", "--server", "koa"]);
	expect(wrong).toMatchObject({ exit: 1, err: '"koa" is not a server blokctl knows. Use fastify, hono or express.' });
	expect(existsSync(join(dir, "other"))).toBe(false);

	for (const [library, lines] of [
		[
			"hono",
			[
				'import { blokHono } from "@blokjs/kernel/hono";',
				'app.route("/", await blokHono({ dir: import.meta.dirname, ports }));',
			],
		],
		[
			"express",
			[
				'import { blokExpress } from "@blokjs/kernel/express";',
				"app.use(await blokExpress({ dir: import.meta.dirname, ports }));   // before express.json()",
			],
		],
		[
			"fastify",
			[
				'import { blokFastify } from "@blokjs/kernel/fastify";',
				"await app.register(blokFastify, { dir: import.meta.dirname, ports });",
			],
		],
	] as const) {
		const existing = join(dir, `has-${library}`);
		write(
			existing,
			"package.json",
			JSON.stringify({ name: "existing", type: "module", dependencies: { [library]: "*" } }),
		);
		const added = blokctl(existing, ["init"]);
		expect(added.exit).toBe(0);
		for (const line of lines) expect(added.out).toContain(line);
		expect(added.out).toContain(`Add this to your ${library[0].toUpperCase()}${library.slice(1)} server:`);
	}
});
