// The "done when" of phase 1, run for real: start from an empty folder, install the two packages
// as packed tarballs (what `npm publish` would upload), and end with a server that answers.
//
//   bun e2e/empty-folder.ts bun     install with bun, run with bun
//   bun e2e/empty-folder.ts npm     install with npm, run with node
//
// The one thing that cannot be done before the packages are published is `bunx blokctl@next init`.
// The built command is run from this repo for that single step, and from node_modules after it.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tool = process.argv[2] === "npm" ? "npm" : "bun";
const runtime = tool === "npm" ? "node" : "bun";
const repo = join(import.meta.dirname, "..");
const work = realpathSync(mkdtempSync(join(tmpdir(), "blok-e2e-")));
const agent = tool === "npm" ? "npm/11.0.0 node/v24.0.0" : "bun/1.3.0";
const env = { ...process.env, npm_config_user_agent: agent };

function sh(cwd: string, command: string, ...args: string[]): string {
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

async function serve(cwd: string, file: string, test: (url: string) => Promise<void>) {
	const port = await freePort();
	console.log(`$ PORT=${port} ${runtime} ${file}`);
	let output = "";
	const app: ChildProcess = spawn(runtime, [file], { cwd, env: { ...env, PORT: String(port) } });
	app.stdout?.on("data", (chunk) => {
		output += chunk;
	});
	app.stderr?.on("data", (chunk) => {
		output += chunk;
	});
	try {
		const url = `http://127.0.0.1:${port}`;
		const deadline = Date.now() + 20_000;
		for (;;) {
			if (app.exitCode !== null) throw new Error(`The server stopped:\n${output}`);
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
	} finally {
		app.kill("SIGTERM");
	}
}

/** Points the project at the packed tarballs, so the install is a real one and not a link into this repo. */
function useTarballs(dir: string, tarballs: { kernel: string; cli: string }) {
	const file = join(dir, "package.json");
	const manifest = JSON.parse(readFileSync(file, "utf8"));
	manifest.dependencies = { ...manifest.dependencies, "@blokjs/kernel": `file:${tarballs.kernel}`, zod: "^4.2.0" };
	manifest.devDependencies = { ...manifest.devDependencies, blokctl: `file:${tarballs.cli}` };
	// blokctl depends on @blokjs/kernel by version, and that version is not on npm yet.
	manifest.overrides = { "@blokjs/kernel": `file:${tarballs.kernel}` };
	writeFileSync(file, `${JSON.stringify(manifest, null, "\t")}\n`);
}

const priceNode = `import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "shop/price@1",
	description: "Prices a quantity of one product.",
	input: z.object({ sku: z.string(), qty: z.number().int().positive() }),
	output: z.object({ totalCents: z.number().int() }),
	errors: ["unknown_sku"],
	run({ sku, qty }, { fail }) {
		const each = { book: 2500, desk: 18000 }[sku];
		if (each === undefined) throw fail("unknown_sku", \`There is no product "\${sku}".\`);
		return { totalCents: each * qty };
	},
});
`;
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
  totalCents = price.outputs.totalCents
}
`;
const post = (url: string, body: unknown) =>
	fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

try {
	console.log(`\n== Pack the two packages (${tool} install, ${runtime} to run)`);
	sh(repo, "bun", "run", "build");
	const packed = join(work, "tarballs");
	mkdirSync(packed);
	sh(join(repo, "packages", "kernel"), "bun", "pm", "pack", "--destination", packed, "--quiet");
	sh(join(repo, "packages", "cli"), "bun", "pm", "pack", "--destination", packed, "--quiet");
	const names = readdirSync(packed).sort();
	show(names.join("\n"));
	const tarballs = { cli: join(packed, names[0]), kernel: join(packed, names[1]) };
	const init = join(repo, "packages", "cli", "dist", "cli.js");

	// ------------------------------------------------------------------------------------------
	console.log("\n== A new project, from an empty folder");
	const empty = join(work, "empty");
	mkdirSync(empty);
	show(sh(empty, "node", init, "init", "my-api"));
	const api = join(empty, "my-api");
	useTarballs(api, tarballs);
	sh(api, tool, "install");
	const blokctl = join(api, "node_modules", ".bin", "blokctl");
	expect("blokctl comes from the install, not from this repo", realpathSync(blokctl).startsWith(api), true);

	show(sh(api, blokctl, "new", "node", "shop/price"));
	writeFileSync(join(api, "nodes/shop/price/v1/node.ts"), priceNode);
	writeFileSync(join(api, "nodes/shop/price/v1/node.test.ts"), priceTest);
	show(sh(api, blokctl, "new", "workflow", "price"));
	writeFileSync(join(api, "workflows/price.pkl"), priceWorkflow);
	show(sh(api, blokctl, "check"));
	show(sh(api, blokctl, "build"));
	// The scaffolded test for the sample node and the one written above, with the project's own test command.
	const tests = sh(api, tool, "run", "test");
	expect("the node tests pass", /\b2 pass\b|# pass 2\b|pass 2\b/.test(tests), true);
	await serve(api, "app.ts", async (url) => {
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
	});

	// ------------------------------------------------------------------------------------------
	console.log("\n== An existing Fastify app");
	const legacy = join(work, "legacy");
	mkdirSync(legacy);
	writeFileSync(
		join(legacy, "package.json"),
		`${JSON.stringify({ name: "legacy", private: true, type: "module", dependencies: { fastify: "^5.0.0" } }, null, "\t")}\n`,
	);
	const server = (extra: { imports: string; register: string }) => `import Fastify from "fastify";
${extra.imports}
const app = Fastify();
app.get("/health", () => ({ ok: true }));
${extra.register}
console.log(await app.listen({ port: Number(process.env.PORT ?? 3000) }));
`;
	writeFileSync(join(legacy, "server.ts"), server({ imports: "", register: "" }));
	show(sh(legacy, "node", init, "init"));
	useTarballs(legacy, tarballs);
	sh(legacy, tool, "install");
	const legacyCtl = join(legacy, "node_modules", ".bin", "blokctl");
	sh(legacy, legacyCtl, "new", "node", "shop/price");
	writeFileSync(join(legacy, "nodes/shop/price/v1/node.ts"), priceNode);
	sh(legacy, legacyCtl, "new", "workflow", "price");
	writeFileSync(join(legacy, "workflows/price.pkl"), priceWorkflow);
	// The whole change to their server: two imports and one register line.
	writeFileSync(
		join(legacy, "server.ts"),
		server({
			imports: 'import { blokFastify } from "@blokjs/kernel/fastify";\nimport { ports } from "./ports/index.ts";',
			register: "await app.register(blokFastify, { dir: import.meta.dirname, ports });",
		}),
	);
	show(sh(legacy, legacyCtl, "build"));
	await serve(legacy, "server.ts", async (url) => {
		expect("their own route still answers", await (await fetch(`${url}/health`)).json(), { ok: true });
		const price = await post(`${url}/price`, { sku: "book", qty: 3 });
		expect("the workflow is mounted beside it", [price.status, await price.json()], [200, { totalCents: 7500 }]);
	});

	console.log(`\nAll of it worked with ${tool} and ${runtime}.`);
} finally {
	rmSync(work, { recursive: true, force: true });
}
