// init and new. They only ever add files: nothing that exists is overwritten.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Paths, locate } from "./analyze.ts";
import type { Report } from "./commands.ts";
import { LANGUAGES, type Language, PYTHON, TYPESCRIPT, languageOf } from "./language.ts";
import { LOCK_FILE } from "./lock.ts";
import { pascal } from "./pkl.ts";
import {
	pyproject,
	pythonApp,
	pythonMount,
	pythonNodeFile,
	pythonNodeRules,
	pythonPorts,
	pythonStartRules,
	pythonTestFile,
} from "./python.ts";
import { standaloneVersion } from "./standalone.ts";

const SEGMENT = /^[a-z][a-z0-9-]*$/;
const VERSION: string =
	standaloneVersion() ??
	JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version;
export { VERSION };

const camel = (text: string) => text.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());

/** Writes a file unless one is already there. Returns whether it wrote. */
function add(file: string, content: string): boolean {
	if (existsSync(file)) return false;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
	return true;
}

// ---- templates ---------------------------------------------------------------------------

const blokFile = `import { blok } from "@blokjs/kernel";
import type { Ports } from "#ports";

// The whole link between this app and Blok: nodes are written with \`node\`, and \`runtime\` runs them.
export const { node, runtime } = blok<Ports>();
`;

const portsFile = `// Ports: everything a node may reach outside itself, such as a database, a payment provider or a mailer.
// A node only sees this interface. What is behind it is decided where the app starts.
export interface Ports {
	clock: { now(): Date };
}

/**
 * A fresh in-memory set of ports. The app runs on it until real ones exist, and each test calls it,
 * so that nothing one test stores is seen by another.
 */
export function memoryPorts(options: { now?: () => Date } = {}): Ports {
	return {
		clock: { now: options.now ?? (() => new Date()) },
	};
}

export const ports: Ports = memoryPorts();
`;

function nodeFile(id: string, body?: { description: string; input: string; output: string; run: string }): string {
	if (body) {
		return `import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "${id}",
	description: "${body.description}",
	input: ${body.input},
	output: ${body.output},
	${body.run}
});
`;
	}
	return `import { todo } from "@blokjs/kernel";
import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "${id}",
	description: "Say in one sentence what this node does.",
	input: z.object({}),
	output: z.object({}),
	// Business failures a workflow may react to, each with when it happens:
	//   errors: { card_declined: "The provider refused the card." },
	// \`fail()\` refuses a code that is not listed here.
	errors: {},
	// The contract above is enough to wire this node into a workflow. Replace \`todo\` with the logic:
	//   async run(input, { ports, fail }) { ... }
	run: todo,
});
`;
}

function nodeTestFile(id: string, name: string, sample?: { input: string; output: string }): string {
	return `import assert from "node:assert/strict";
import { test } from "node:test";
import { runtime } from "#blok";
import { memoryPorts } from "#ports";
import ${camel(name)} from "./node.ts";

test("${id} answers with what its contract promises", async () => {
	// Fresh ports for every test, so nothing one test stores is seen by another.
	const { call } = runtime({ ports: memoryPorts({ now: () => new Date("2026-01-01T00:00:00Z") }) });
	const output = await call(${camel(name)}, ${sample?.input ?? "{}"});
	assert.deepEqual(output, ${sample?.output ?? "{}"});
});

// One test for each error in the contract:
//   await assert.rejects(call(${camel(name)}, { ... }), { code: "the_error_code" });
`;
}

export const TRIGGERS = ["http", "cron", "queue", "mcp"] as const;
export type TriggerKind = (typeof TRIGGERS)[number];

const TRIGGER_PKL: Record<TriggerKind, (name: string) => string> = {
	http: (name) => `trigger {
  http = new {
    method = "POST"
    path = "/${name}"
  }
}`,
	cron: () => `trigger {
  // Five parts: minute, hour, day of month, month, day of week. This is every day at 02:00, in UTC.
  cron = new {
    schedule = "0 2 * * *"
    // Nobody sends a schedule anything, so what the steps read as "\${request.body.x}" is written here:
    // body { x = "..." }
  }
}`,
	queue: (name) => `trigger {
  // Runs once per message of this queue. The steps read the message as "\${request.body.x}".
  queue = new {
    name = "${name}"
  }
}`,
	mcp: (name) => `// An agent chooses a tool by its description. Say what this one does and when to use it:
//
//   description = "..."

trigger {
  // An AI agent calls this workflow as the tool "${name.replaceAll("-", "_")}". The steps read its arguments as "\${request.body.x}".
  mcp = new {}
}`,
};

const TRIGGER_JSON: Record<TriggerKind, (name: string) => object> = {
	http: (name) => ({ http: { method: "POST", path: `/${name}` } }),
	cron: () => ({ cron: { schedule: "0 2 * * *" } }),
	queue: (name) => ({ queue: { name } }),
	mcp: () => ({ mcp: {} }),
};

function workflowPkl(name: string, trigger: TriggerKind): string {
	return `amends "blok/Workflow.pkl"

// Import each module whose nodes this workflow uses, right here, before anything else:
//
//   import "blok/orders.pkl"
//
// \`blokctl list\` shows every node, what it takes, and the name to write for it.

name = "${pascal(name)}"
version = "1.0.0"

${TRIGGER_PKL[trigger](name)}

// One step per node:
//
//   local order = new orders.ValidateOrder {
//     name = "order"
//     inputs { customerId = "\${request.body.customerId}" }
//   }
//
// Then list the steps in the order they run, and say what the workflow answers with.

steps {
}
`;
}

const workflowJson = (name: string, trigger: TriggerKind) =>
	`${JSON.stringify(
		{
			$schema: "./blok/workflow.schema.json",
			name: pascal(name),
			version: "1.0.0",
			trigger: TRIGGER_JSON[trigger](name),
			steps: [],
		},
		null,
		"\t",
	)}\n`;

const helloPkl = `amends "blok/Workflow.pkl"

import "blok/hello.pkl"

name = "Hello"
description = "Greets whoever asks."
version = "1.0.0"

trigger {
  http = new {
    method = "GET"
    path = "/hello"
  }
}

local greeting = new hello.Greet {
  name = "greeting"
  inputs { name = "\${request.query.name}" }
}

steps {
  greeting
}

result {
  message = greeting.outputs.message
  at = greeting.outputs.at
}
`;

export const SERVERS = ["fastify", "hono", "express"] as const;
export type ServerKind = (typeof SERVERS)[number];

interface Server {
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
	/** The lines that put Blok's routes on a server, as shown to someone who already has one. */
	mount: (dir: string) => string[];
	/** app.ts of a new project. */
	app: string;
}

const loadLines = `// Loads the nodes and the built workflows once. Everything below starts from it.
const blok = await loadApp({ dir: import.meta.dirname, ports, env: process.env });`;
const cronLines = `// Every workflow with a cron trigger runs on its schedule. With none, this does nothing.
await startCron(blok);`;

const SERVER: Record<ServerKind, Server> = {
	fastify: {
		dependencies: { fastify: "^5.0.0" },
		devDependencies: {},
		mount: (dir) => [
			`import { blokFastify } from "@blokjs/kernel/fastify";`,
			`await app.register(blokFastify, { dir: ${dir}, ports });`,
		],
		app: `import { loadApp } from "@blokjs/kernel";
import { startCron } from "@blokjs/kernel/cron";
import { blokFastify } from "@blokjs/kernel/fastify";
import Fastify from "fastify";
import { ports } from "./ports/index.ts";

${loadLines}

const app = Fastify();
// Every workflow with an HTTP trigger becomes a route. The rest of this server is yours.
await app.register(blokFastify, blok);
${cronLines}

console.log(await app.listen({ port: Number(process.env.PORT ?? 3000) }));
`,
	},
	hono: {
		dependencies: { hono: "^4.0.0", "@hono/node-server": "^2.0.0" },
		devDependencies: {},
		mount: (dir) => [
			`import { blokHono } from "@blokjs/kernel/hono";`,
			`app.route("/", await blokHono({ dir: ${dir}, ports }));`,
		],
		app: `import { loadApp } from "@blokjs/kernel";
import { startCron } from "@blokjs/kernel/cron";
import { blokHono } from "@blokjs/kernel/hono";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { ports } from "./ports/index.ts";

${loadLines}

const app = new Hono();
// Every workflow with an HTTP trigger becomes a route. The rest of this server is yours.
app.route("/", await blokHono(blok));
${cronLines}

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, ({ port }) =>
	console.log(\`http://localhost:\${port}\`),
);
`,
	},
	express: {
		dependencies: { express: "^5.0.0" },
		devDependencies: { "@types/express": "^5.0.0" },
		mount: (dir) => [
			`import { blokExpress } from "@blokjs/kernel/express";`,
			`app.use(await blokExpress({ dir: ${dir}, ports }));   // before express.json()`,
		],
		app: `import { loadApp } from "@blokjs/kernel";
import { startCron } from "@blokjs/kernel/cron";
import { blokExpress } from "@blokjs/kernel/express";
import express from "express";
import { ports } from "./ports/index.ts";

${loadLines}

const app = express();
// Every workflow with an HTTP trigger becomes a route. The rest of this server is yours.
// Keep this before express.json(), so a signed webhook can be checked against the body as it arrived.
app.use(await blokExpress(blok));
${cronLines}

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(\`http://localhost:\${port}\`));
`,
	},
};

const tsconfigFile = `{
	"compilerOptions": {
		"target": "ES2023",
		"module": "NodeNext",
		"moduleResolution": "NodeNext",
		"strict": true,
		"noEmit": true,
		"allowImportingTsExtensions": true,
		"verbatimModuleSyntax": true,
		"skipLibCheck": true,
		"types": ["node"]
	},
	"include": ["**/*.ts"],
	"exclude": ["node_modules"]
}
`;

const START = "<!-- blok:start -->";
const END = "<!-- blok:end -->";

/** The page an AI agent reads before it touches the project. */
function rules(prefix: string, runner: string, lang: Language = TYPESCRIPT): string {
	const at = (path: string) => `${prefix}${path}`;
	const page = `${START}
## Blok: how this backend is built

Logic lives in **nodes**. **Workflows** wire nodes together and hold no logic. Run \`${runner} check\` before you say you are done.

### Rules

1. One node, one folder: \`${at(`nodes/<module>/<node>/v<N>/${lang.nodeFile}`)}\`. The path is the id: \`<module>/<node>@<N>\`.
2. A node declares its \`input\`, \`output\` and \`errors\`, and returns its output. It never imports another node.
3. A node reaches the outside world only through \`ports\` (\`${at(lang.portsFile)}\`). No database client, HTTP call or clock of its own.
4. A loop that waits for something, such as paging or polling, lives inside a node.
5. A workflow only wires: steps, \`if\`, \`each\`, \`conditions\`, \`parallel\`, \`onError\`. There is no code in a workflow.
6. Workflows are written in Pkl in \`${at("workflows/<name>.pkl")}\`. A node is a step by its module and name: \`billing/charge-card@1\` is \`billing.ChargeCard\`, after \`import "blok/billing.pkl"\`. Version 2 is \`billing.ChargeCardV2\`, and a module with a hyphen loses it: \`user-accounts\` is \`userAccounts\`. Another workflow is \`workflows.PlaceOrder\`, after \`import "blok/workflows.pkl"\`.
7. Point at an earlier step with typed references: \`order.outputs.items\`, \`price.outputs.totalCents.gt(10000)\`. Use a string such as \`"\${request.body.token}"\` only for the request, \`item\` and \`error\`.
8. Do not give a step variable the name of a module you import. With \`import "blok/billing.pkl"\`, write \`local charge = ...\`, not \`local billing = ...\`. It also cannot be a word Pkl keeps for itself, such as \`open\`, \`new\`, \`in\`, \`out\`, \`is\`, \`as\`, \`for\`, \`let\`, \`when\`, \`if\`, \`else\`, \`import\`, \`function\`, \`local\`, \`module\`, \`class\`, \`this\`, \`super\`, \`delete\`, \`read\`, \`case\`, \`switch\`, \`record\`, \`const\`, \`fixed\` or \`hidden\`.
9. Never change the \`input\` or \`output\` of a node that a workflow already uses. Run \`blokctl new version <module>/<node>\` and change the copy.
10. Never edit generated files: \`${at("workflows/blok/")}\` and \`${at(".blok/")}\`.
11. A node whose logic is not written yet has \`${lang.todo}\`. Its contract is real, so workflows can already use it.
12. Steps are not a transaction: something else can happen between two of them. A rule that must hold at the moment of a write, such as a limit or a unique email, is enforced by the node that writes, in one call to a port. A step that changes something outside gets an \`undo\`, so that a failure in a later step takes it back.
13. Never edit a \`contract.json\`. It is what the node promised when the app was designed, and \`blokctl check\` refuses a node that no longer matches it.

### Commands

${lang.name === "python" ? `Run them as \`blokctl ...\`. \`blokctl --version\` says ${VERSION}: an older blokctl on the machine is another tool.` : `Run them as \`${runner} ...\`, which uses this project's own copy. A bare \`blokctl\` may be another version installed on the machine.`}

| Command | What it does |
| --- | --- |
| \`blokctl list\` | Every node and workflow: what each takes and answers with, and the name to write for it in a workflow. Read this before reading code. |
| \`blokctl show <id>\` | One node or workflow in full, with its contract and the workflows that use it. |
| \`blokctl status\` | Which nodes are still empty, untested or not locked. |
| \`blokctl new node <module>/<node>\` | Creates the folder, the contract and a test. |
| \`blokctl new workflow <name>\` | Creates the Pkl file, started by an HTTP route. \`--trigger cron\`, \`queue\` or \`mcp\` starts it another way. |
| \`blokctl new version <module>/<node>\` | Copies the newest version to the next one. |
| \`blokctl check\` | Says whether everything lines up, and what is wrong in full sentences. |
| \`blokctl check <node>\` | The gate for one node: the project lines up, the node is written, its contract is unchanged${lang.name === "python" ? " and its tests pass" : ", its tests pass and its types check"}. |
| \`blokctl check --tests\` | The whole project: everything lines up${lang.name === "python" ? " and every node's tests pass" : ", every node's tests pass and the types check"}. |
| \`blokctl run <id> --input '<json>'\` | Runs one node or workflow and prints what it answers with and what ran. |
| \`blokctl lock\` | Writes \`contract.json\` beside every node that has none. Run it when the contracts are settled. |
| \`blokctl build\` | Writes the JSON the server loads, and \`.blok/openapi.json\`. Refuses while a node is still empty. |
| \`blokctl openapi\` | Prints every route as an OpenAPI 3.1 document: what it takes, what it answers with, and each error with its status. |
| \`blokctl dev -- <start command>\` | Rebuilds and restarts the server on every change. |

Every command takes \`--json\`.

### Writing a node

\`\`\`ts
import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "billing/charge-card@1",
	description: "Charges a card token for an order.",
	input: z.object({ orderId: z.string(), amountCents: z.number().int().positive(), token: z.string() }),
	output: z.object({ receiptId: z.string() }),
	errors: { card_declined: "The provider refused the card." },
	async run(input, { ports, fail }) {
		const result = await ports.payments.charge(input.token, input.amountCents);
		if (!result.ok) throw fail("card_declined", result.reason);
		return { receiptId: result.id };
	},
});
\`\`\`

This is an example. The ports of this project are in \`${at("ports/index.ts")}\`, and they are the ones to use.

- \`input\` reaches \`run\` already checked against the schema, with any field the schema does not list removed. What \`run\` returns is checked against \`output\` the same way, so return the output's fields and nothing else.
- The second argument of \`run\` holds \`ports\`, \`fail\`, \`log\` and \`signal\`. Take what you use: a node that reaches nothing outside can leave it out. \`run\` may be async or not.
- A node that is not written yet has \`run: todo\`, with \`todo\` imported from \`@blokjs/kernel\`. Remove that import when you write the logic.
- Anything thrown that is not a \`fail(...)\` is an unexpected failure: the caller gets a 500 with the error \`unexpected\` and no detail. What was thrown goes to the server's log.
- \`input\` and \`output\` must be describable as JSON Schema. Avoid \`.transform()\`, \`z.date()\`, \`z.undefined()\` and \`z.bigint()\`: \`blokctl check\` names the node when a schema cannot be described. Use \`.describe()\` on a field whose meaning is not obvious from its name.
- A caller that sends a wrong or missing field gets a 400 with the error \`invalid_input\` on its own. Do not write a node to validate a request.
- \`throw fail("card_declined", "The bank refused the card.")\` ends the node with that error. The caller receives the code and the message, so write the message for them and put nothing secret in it.
- Optional: \`idempotent: true\` with \`retries: 2\` runs the node again when it fails unexpectedly, which is only right when running it twice does no harm. \`timeoutMs\` stops it after that long. \`effects\` names the ports it uses, such as \`effects: ["payments"]\`. Nothing reads it but people.

Its test goes beside it, in \`node.test.ts\`. Tests are written with \`node:test\`, which both Node and Bun run:

\`\`\`ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { runtime } from "#blok";
import { memoryPorts } from "#ports";
import chargeCard from "./node.ts";

test("charges the card and answers with the receipt", async () => {
	// Fresh ports for every test, so nothing one test stores is seen by another.
	const ports = memoryPorts();
	const { call } = runtime({ ports });
	const output = await call(chargeCard, { orderId: "o_1", amountCents: 500, token: "tok_ok" });
	// What the in-memory port answers is decided in ${at("ports/index.ts")}. Read it there, do not guess it.
	assert.deepEqual(output, { receiptId: "rc_1" });
});

test("fails with card_declined when the provider refuses", async () => {
	const { call } = runtime({ ports: memoryPorts() });
	// A business failure rejects with an error whose \`code\` is the one from the contract.
	await assert.rejects(call(chargeCard, { orderId: "o_1", amountCents: 500, token: "tok_bad" }), { code: "card_declined" });
});
\`\`\`

### Writing a workflow

\`\`\`pkl
amends "blok/Workflow.pkl"

import "blok/billing.pkl"
import "blok/orders.pkl"

name = "Checkout"
version = "1.0.0"

trigger {
  http = new {
    method = "POST"
    path = "/orders"
    errors { ["card_declined"] = 402 }
  }
}

local order = new orders.ValidateOrder {
  name = "order"
  inputs { items = "\${request.body.items}" }
}

local charge = new billing.ChargeCard {
  name = "charge"
  inputs {
    orderId = order.outputs.orderId
    amountCents = order.outputs.totalCents
    token = "\${request.body.token}"
  }
}

steps {
  order
  charge
}

result {
  receiptId = charge.outputs.receiptId
}
\`\`\`

### What a workflow can do

Each of these goes in a step, or in the list of steps. \`blokctl check\` reports a mistake Pkl finds in Pkl's own words, with the file and the line, one at a time. Every other mistake is a full sentence.

\`\`\`pkl
// Read the request. A request is { body, query, params, headers }.
// A query string, a path parameter and a header arrive as text. Where the node asks for a number,
// true/false or a list, the text is read as one, so "?page=2" reaches the node as the number 2.
inputs { email = "\${request.body.email}"; page = "\${request.query.page}" }

// A path can have parameters. They are read from request.params.
path = "/loans/:loanId/return"
inputs { loanId = "\${request.params.loanId}" }

// Run a step only when something holds. The result of a step that may be skipped cannot be read later.
\`if\` = price.outputs.totalCents.gt(10000)   // numbers: gt gte lt lte. Anything: eq ne. A boolean field as it is.
\`if\` = "\${request.query.verbose} == true"   // the request, written as a string

// Run a step once per element of a list. Its result is the list of results: read it with .value.
each = "\${request.body.items}"
concurrency = 4
inputs { sku = "\${item.sku}" }

// Choose one branch. The first that holds runs.
new Conditions {
  conditions {
    new If { \`if\` = tier.outputs.tier.eq("vip"); steps { courier } }
    new Else { \`else\` { post } }
  }
}

// Run steps at the same time.
new Parallel { parallel { shipment; receipt } }

// Refuse the request with an error code, with no node for it. With \`if\`, only when the condition holds.
new Fail { fail = "order_not_paid"; \`if\` = order.outputs.status.ne("paid"); message = "Only a paid order can ship." }

// Take a step back when a LATER step fails. Undo steps run newest first, and the workflow still fails.
local charge = new billing.ChargeCard {
  name = "charge"
  inputs { token = "\${request.body.token}"; amountCents = total.outputs.totalCents }
  undo { new billing.RefundPayment { name = "refund"; inputs { paymentId = charge.outputs.paymentId } } }
}

// Run steps when THIS step fails. They can read "\${error.code}". The workflow still fails afterwards.
onError { new orders.ReleaseStock { name = "release"; inputs { orderId = order.outputs.orderId } } }

// Answer with fields, or with one step's whole result. Left out, the answer is the last step's result.
result { receiptId = charge.outputs.receiptId }
result = charge.value
\`\`\`

- Every error a step can fail with needs a status in the HTTP trigger's \`errors\`. \`blokctl check\` refuses a workflow that leaves one out, because the caller would get a 500.
- A successful answer is 200. A workflow that creates something says \`status = 201\` in its trigger, beside \`method\` and \`path\`.
- A workflow's id is its file name and the first number of its version: \`checkout.pkl\` with \`version = "1.0.0"\` is \`workflows/checkout@1\`.
- A \`Fail\` code needs a status in the trigger's \`errors\` like any other error.
- A workflow cannot compute, cannot join two conditions with and/or, and cannot loop until something is true. Each of those is a node's job.

### What starts a workflow

The \`trigger\` says what starts a workflow from outside. A workflow may have one of each kind, and one with no trigger is only a step in other workflows. Whatever starts it, the steps read what it was given as \`"\${request.body.x}"\`. Only an HTTP request also has \`request.query\`, \`request.params\` and \`request.headers\`.

\`\`\`pkl
// A route.
trigger { http = new { method = "POST"; path = "/orders"; status = 201; errors { ["card_declined"] = 402 } } }

// A webhook: a route that answers 401 unless the request's signature matches. \`secret\` is the NAME of
// an environment variable, never the secret. Schemes: "standard" (Standard Webhooks), "stripe", "github",
// and "hmac" with the \`header\` that carries the signature.
trigger {
  http = new {
    method = "POST"
    path = "/webhooks/payments"
    status = 202
    signature = new { scheme = "standard"; secret = "PAYMENTS_WEBHOOK_SECRET" }
  }
}

// A schedule: minute, hour, day of month, month, day of week. In UTC unless \`timezone\` names another.
// Nobody sends a schedule anything, so \`body\` holds everything the steps read.
trigger { cron = new { schedule = "0 2 * * *"; body { region = "eu" } } }

// A queue. The workflow runs once per message, and the message is the body.
trigger { queue = new { name = "orders.paid"; concurrency = 4 } }

// A tool an AI agent can call. Its arguments are the body. The agent chooses it by the workflow's description.
description = "Prices an order without placing it."
trigger { mcp = new { tool = "quote_order" } }
\`\`\`

A route is served as soon as the server mounts Blok. A schedule, a queue and a tool each need one line where the app starts, in \`app.ts\`. A workflow whose line is missing never runs and never complains, so \`blokctl check\` reminds you of the line when the project has such a trigger:

\`\`\`ts
import { loadApp } from "@blokjs/kernel";
import { startCron } from "@blokjs/kernel/cron";
import { startQueues } from "@blokjs/kernel/queue";

const blok = await loadApp({ dir: import.meta.dirname, ports, env: process.env });
await startCron(blok); // every cron trigger
await startQueues(blok, { subscribe }); // every queue trigger. \`subscribe(queue, handle, { concurrency })\` connects your broker.
\`\`\`

Tools are served by a file of their own, which the agent's program starts. It needs the package \`@modelcontextprotocol/sdk\`:

\`\`\`ts
import { blokMcp } from "@blokjs/kernel/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = await blokMcp(blok, { name: "my-api", version: "1.0.0" });
await server.connect(new StdioServerTransport());
\`\`\`

- A node puts a message on a queue through a port, like everything else outside. Until there is a broker, \`memoryQueue()\` from \`@blokjs/kernel/queue\` is a queue inside the process: give its \`send\` to the port and its \`subscribe\` to \`startQueues\`.
- A queue hands a message over at least once. A node that a queue workflow reaches must be safe to run twice with the same message: it asks a port, in one call, whether that message was already handled.
- A message the workflow refuses, because it lacks a field or a step fails with a business error, is not handed over again. A failure nobody planned for is.
- A webhook answers fast and works later: the signed workflow puts the event on a queue and answers 202, and a queue workflow does the rest.
- A schedule, a queue message and a tool call have no caller waiting for a status, so their errors need no entry in \`errors\`. A run that fails is written to the log.
- A schedule runs inside the app. An app that runs as several copies calls \`startCron\` in one of them.
- A route, a queue and a tool name each belong to one workflow. \`blokctl check\` refuses a second workflow that claims one.

The full schema is \`${at("workflows/blok/Workflow.pkl")}\`, which \`blokctl check\` writes once there is a workflow.

The check compares what a step gives with what the next one takes all the way down: the fields of an object, the items of a list, and whether a value may be null.
${END}
`;
	if (lang.name !== "python") return page;
	// The same page for a Python project: how a node is written and what starts the app are said in Python.
	const between = (text: string, from: string, to: string, put: string) => {
		const [start, end] = [text.indexOf(from), text.indexOf(to)];
		if (start < 0 || end < start) throw new Error(`The rules page has no part from "${from}" to "${to}".`);
		return text.slice(0, start) + put + text.slice(end);
	};
	const nodes = between(page, "### Writing a node", "### Writing a workflow", `${pythonNodeRules(at)}\n`);
	return between(
		nodes,
		"A route is served as soon as",
		"- A queue hands a message over",
		`${pythonStartRules}\n`,
	).replace("calls `startCron` in one of them", "calls `start_cron` in one of them");
}

/** How this project runs blokctl: its own copy through the package manager, or the single file on the PATH. */
export const ownCommand = (paths: Paths): string =>
	paths.language.name === "python" ? "blokctl" : `${usesBun(paths.root) ? "bunx" : "npx"} blokctl`;

// ---- init --------------------------------------------------------------------------------

function mergeRules(file: string, section: string): boolean {
	if (!existsSync(file)) {
		writeFileSync(file, `# Notes for AI agents\n\n${section}`);
		return true;
	}
	const current = readFileSync(file, "utf8");
	const start = current.indexOf(START);
	const end = current.indexOf(END);
	const next =
		start >= 0 && end > start
			? current.slice(0, start) + section.trimEnd() + current.slice(end + END.length)
			: `${current.trimEnd()}\n\n${section}`;
	if (next === current) return false;
	writeFileSync(file, next);
	return true;
}

function ignore(file: string, entries: string[]): boolean {
	const current = existsSync(file) ? readFileSync(file, "utf8") : "";
	const have = new Set(current.split("\n").map((line) => line.trim()));
	const missing = entries.filter((entry) => !have.has(entry));
	if (missing.length === 0) return false;
	writeFileSync(file, `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`);
	return true;
}

export const usesBun = (root: string) =>
	"bun" in process.versions ||
	(process.env.npm_config_user_agent ?? "").startsWith("bun") ||
	existsSync(join(root, "bun.lock")) ||
	existsSync(join(root, "bun.lockb"));

/**
 * `init <name>` starts a new project that already answers on GET /hello.
 * `init` inside an existing app adds the folders and the rules page, and leaves the server alone.
 */
export function init(
	cwd: string,
	options: { name?: string; dir?: string; server?: string; lang?: string } = {},
): Report {
	const fresh = options.name !== undefined;
	const root = fresh ? resolve(cwd, options.name as string) : cwd;
	if (options.lang !== undefined && !(options.lang in LANGUAGES)) {
		return fail(`"${options.lang}" is not a language blokctl knows. Use typescript or python.`);
	}
	// A new project is TypeScript unless told otherwise. An existing one is whatever it already is.
	const lang = options.lang ? LANGUAGES[options.lang as keyof typeof LANGUAGES] : fresh ? TYPESCRIPT : languageOf(root);
	if (lang.name === "python") return initPython(cwd, root, options);
	if (options.server !== undefined && !(SERVERS as readonly string[]).includes(options.server)) {
		return fail(
			`"${options.server}" is not a server blokctl knows. Use ${SERVERS.join(", ").replace(/, ([^,]*)$/, " or $1")}.`,
		);
	}
	if (fresh && existsSync(root) && readdirSync(root).length > 0) {
		return fail(`"${options.name}" already exists and is not empty. Run "blokctl init" inside it to add Blok to it.`);
	}
	if (!fresh && !existsSync(join(root, "package.json"))) {
		return fail('There is no package.json here. Run "blokctl init <name>" to start a new project.');
	}
	const sub = options.dir?.replace(/^\.\//, "").replace(/\/$/, "") ?? "";
	const dir = join(root, sub);
	const prefix = sub ? `${sub}/` : "";
	const bun = usesBun(root);
	// A new project gets Fastify unless told otherwise. An existing one is asked what it already has.
	let installed: Record<string, string> = {};
	try {
		const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		installed = { ...manifest.dependencies, ...manifest.devDependencies };
	} catch {}
	const kind = (options.server ?? SERVERS.find((name) => name in installed) ?? "fastify") as ServerKind;
	const server = SERVER[kind];
	const added: string[] = [];
	const put = (file: string, content: string) => {
		if (add(join(root, file), content)) added.push(file);
	};

	if (fresh) {
		const run = bun ? "bun" : "node";
		put(
			"package.json",
			`${JSON.stringify(
				{
					name: (options.name as string).split(/[\\/]/).pop(),
					private: true,
					type: "module",
					scripts: {
						dev: `blokctl dev -- ${run} app.ts`,
						check: "blokctl check",
						build: "blokctl build",
						start: `${run} app.ts`,
						test: bun ? "bun test" : "node --test",
					},
					imports: { "#blok": "./blok.ts", "#ports": "./ports/index.ts" },
					dependencies: { "@blokjs/kernel": VERSION, ...server.dependencies, zod: "^4.2.0" },
					devDependencies: {
						...server.devDependencies,
						"@types/node": "^24.0.0",
						blokctl: VERSION,
						typescript: "^5.9.0",
					},
				},
				null,
				"\t",
			)}\n`,
		);
		put("tsconfig.json", tsconfigFile);
		put("app.ts", server.app);
	}
	put(`${prefix}blok.ts`, blokFile);
	put(`${prefix}ports/index.ts`, portsFile);
	mkdirSync(join(dir, "nodes"), { recursive: true });
	mkdirSync(join(dir, "workflows"), { recursive: true });
	if (fresh) {
		put(
			"nodes/hello/greet/v1/node.ts",
			nodeFile("hello/greet@1", {
				description: "Builds a greeting for a name.",
				input: 'z.object({ name: z.string().min(1).default("world") })',
				output: "z.object({ message: z.string(), at: z.string() })",
				run: "run: (input, { ports }) => ({ message: `Hello, ${input.name}!`, at: ports.clock.now().toISOString() }),",
			}),
		);
		put(
			"nodes/hello/greet/v1/node.test.ts",
			nodeTestFile("hello/greet@1", "greet", {
				input: '{ name: "Ada" }',
				output: '{ message: "Hello, Ada!", at: "2026-01-01T00:00:00.000Z" }',
			}),
		);
		put("workflows/hello.pkl", helloPkl);
	}
	if (mergeRules(join(root, "AGENTS.md"), rules(prefix, `${bun ? "bunx" : "npx"} blokctl`))) added.push("AGENTS.md");
	if (ignore(join(root, ".gitignore"), fresh ? ["node_modules/", `${prefix}.blok/`] : [`${prefix}.blok/`])) {
		added.push(".gitignore");
	}

	if (!fresh) {
		// The scaffolded nodes import "#blok" and "#ports", so package.json has to say where those are.
		const file = join(root, "package.json");
		const source = readFileSync(file, "utf8");
		const manifest = JSON.parse(source);
		const before = JSON.stringify(manifest);
		// Keep the file's own indentation, so the only lines that change are the ones that were added.
		const indent = /^([ \t]+)"/m.exec(source)?.[1] ?? "\t";
		manifest.imports = { "#blok": `./${prefix}blok.ts`, "#ports": `./${prefix}ports/index.ts`, ...manifest.imports };
		if (sub) manifest.blok = { dir: sub, ...manifest.blok };
		if (JSON.stringify(manifest) !== before) {
			writeFileSync(file, `${JSON.stringify(manifest, null, indent)}\n`);
			added.push("package.json (imports)");
		}
	}

	const install = bun ? "bun install" : "npm install";
	const next = fresh
		? [
				`cd ${options.name}`,
				install,
				`${bun ? "bun" : "npm"} run dev`,
				"Then open http://localhost:3000/hello?name=Ada",
			]
		: [
				`${bun ? "bun add" : "npm install"} @blokjs/kernel zod`,
				`${bun ? "bun add -d" : "npm install -D"} blokctl`,
				"blokctl new node <module>/<node>",
				"blokctl new workflow <name>",
				`Add this to your ${kind[0].toUpperCase()}${kind.slice(1)} server:`,
				...server.mount(sub ? `join(import.meta.dirname, "${sub}")` : "import.meta.dirname").map((line) => `  ${line}`),
				"Run your server with: blokctl dev -- <your start command>",
			];
	const text = [
		added.length > 0 ? `Added:\n${added.map((file) => `  ${file}`).join("\n")}` : "Everything was already in place.",
		"",
		"Next:",
		...next.map((line) => `  ${line}`),
	].join("\n");
	return { ok: true, text, data: { ok: true, root, server: kind, added, next } };
}

/** `init` for a Python project: the same folders and the same rules page, with FastAPI as the server. */
function initPython(cwd: string, root: string, options: { name?: string; dir?: string; server?: string }): Report {
	const fresh = options.name !== undefined;
	if (options.server !== undefined && options.server !== "fastapi") {
		return fail(`"${options.server}" is not a server blokctl knows for Python. It writes a FastAPI app.`);
	}
	if (fresh && existsSync(root) && readdirSync(root).length > 0) {
		return fail(`"${options.name}" already exists and is not empty. Run "blokctl init" inside it to add Blok to it.`);
	}
	if (!fresh && !existsSync(join(root, "pyproject.toml"))) {
		return fail('There is no pyproject.toml here. Run "blokctl init <name> --lang python" to start a new project.');
	}
	const sub = options.dir?.replace(/^\.\//, "").replace(/\/$/, "") ?? "";
	const dir = join(root, sub);
	const prefix = sub ? `${sub}/` : "";
	const added: string[] = [];
	const put = (file: string, content: string) => {
		if (add(join(root, file), content)) added.push(file);
	};

	if (fresh) {
		put("pyproject.toml", pyproject((options.name as string).split(/[\\/]/).pop() as string));
		put("app.py", pythonApp);
	}
	put(`${prefix}ports/__init__.py`, pythonPorts);
	mkdirSync(join(dir, "nodes"), { recursive: true });
	mkdirSync(join(dir, "workflows"), { recursive: true });
	if (fresh) {
		put(
			"nodes/hello/greet/v1/node.py",
			pythonNodeFile("hello/greet@1", "greet", {
				description: "Builds a greeting for a name.",
				input: 'class Input(BaseModel):\n    name: str = Field(default="world", min_length=1)',
				output: "class Output(BaseModel):\n    message: str\n    at: str",
				run: 'def run(input: Input, ctx: Ctx[Ports]) -> Output:\n    return Output(message=f"Hello, {input.name}!", at=ctx.ports.clock.now().isoformat())',
			}),
		);
		put(
			"nodes/hello/greet/v1/test_node.py",
			pythonTestFile("hello/greet@1", "greet", {
				ports: "memory_ports(now=lambda: datetime(2026, 1, 1, tzinfo=timezone.utc))",
				input: '{"name": "Ada"}',
				output: '{"message": "Hello, Ada!", "at": "2026-01-01T00:00:00+00:00"}',
			}),
		);
		put("workflows/hello.pkl", helloPkl);
	}
	if (mergeRules(join(root, "AGENTS.md"), rules(prefix, "blokctl", PYTHON))) added.push("AGENTS.md");
	const ignored = fresh ? [".venv/", "__pycache__/", `${prefix}.blok/`] : [`${prefix}.blok/`];
	if (ignore(join(root, ".gitignore"), ignored)) added.push(".gitignore");

	if (!fresh) {
		// blokctl tells a Python project by this table, and the tests import `ports` from the project folder.
		const file = join(root, "pyproject.toml");
		const source = readFileSync(file, "utf8");
		if (!/^\[tool\.blok\]/m.test(source)) {
			const table = `\n# blokctl reads this table. \`dir\` is the folder that holds nodes/ and workflows/.\n[tool.blok]\ndir = "${sub || "."}"\n`;
			writeFileSync(file, `${source.trimEnd()}\n${table}`);
			added.push("pyproject.toml ([tool.blok])");
		}
	}

	const next = fresh
		? [
				`cd ${options.name}`,
				"uv sync",
				"blokctl dev -- uv run python app.py",
				"Then open http://localhost:3000/hello?name=Ada",
			]
		: [
				'Add "blok-kernel[fastapi]" to your dependencies, and "pytest" to the ones for development',
				`Add this under [tool.pytest.ini_options] in pyproject.toml: pythonpath = ["${sub || "."}"] and addopts = "--import-mode=importlib"`,
				"blokctl new node <module>/<node>",
				"blokctl new workflow <name>",
				"Add this to your FastAPI app:",
				...pythonMount(sub ? `Path(__file__).parent / "${sub}"` : "Path(__file__).parent").map((line) => `  ${line}`),
				"Run your server with: blokctl dev -- <your start command>",
			];
	const text = [
		added.length > 0 ? `Added:\n${added.map((file) => `  ${file}`).join("\n")}` : "Everything was already in place.",
		"",
		"Next:",
		...next.map((line) => `  ${line}`),
	].join("\n");
	return { ok: true, text, data: { ok: true, root, language: "python", server: "fastapi", added, next } };
}

// ---- new ---------------------------------------------------------------------------------

const fail = (text: string): Report => ({ ok: false, text, data: { ok: false, problems: [text] } });

function nodePath(id: string): { module: string[]; name: string } | undefined {
	const parts = id.split("/");
	if (parts.length < 2 || !parts.every((part) => SEGMENT.test(part))) return undefined;
	return { module: parts.slice(0, -1), name: parts.at(-1) as string };
}

const versionsOf = (folder: string) =>
	existsSync(folder)
		? readdirSync(folder)
				.filter((entry) => /^v[1-9][0-9]*$/.test(entry))
				.map((entry) => Number(entry.slice(1)))
				.sort((a, b) => a - b)
		: [];

export function newNode(paths: Paths, id: string): Report {
	const where = nodePath(id);
	if (!where)
		return fail(`"${id}" is not a node name. Write <module>/<node> in lower case, such as billing/charge-card.`);
	const folder = join(paths.nodes, ...where.module, where.name);
	if (versionsOf(folder).length > 0) {
		return fail(`${id} already exists. To change what it takes or answers with, run "blokctl new version ${id}".`);
	}
	const lang = paths.language;
	const python = lang.name === "python";
	const files = [join(folder, "v1", lang.nodeFile), join(folder, "v1", lang.testFile)];
	add(files[0], python ? pythonNodeFile(`${id}@1`, where.name) : nodeFile(`${id}@1`));
	add(files[1], python ? pythonTestFile(`${id}@1`, where.name) : nodeTestFile(`${id}@1`, where.name));
	const shown = files.map((file) => relative(process.cwd(), file));
	const text = `Created ${id}@1:\n${shown.map((file) => `  ${file}`).join("\n")}\nIts contract is empty and its logic is \`todo\`. Fill in the input and output first.`;
	return { ok: true, text, data: { ok: true, id: `${id}@1`, files: shown } };
}

export function newVersion(paths: Paths, id: string): Report {
	const where = nodePath(id.split("@")[0]);
	if (!where) return fail(`"${id}" is not a node name. Write <module>/<node>, such as billing/charge-card.`);
	const base = [...where.module, where.name].join("/");
	const folder = join(paths.nodes, ...where.module, where.name);
	const latest = versionsOf(folder).at(-1);
	if (!latest) return fail(`${base} does not exist yet. Run "blokctl new node ${base}".`);
	const from = join(folder, `v${latest}`);
	const to = join(folder, `v${latest + 1}`);
	cpSync(from, to, { recursive: true });
	// The copy is a new contract in the making. It is locked again when it is settled.
	rmSync(join(to, LOCK_FILE), { force: true });
	// The id is in the node file and usually in its test. Nothing else in the copy changes.
	for (const file of readdirSync(to, { recursive: true, encoding: "utf8" })) {
		if (!paths.language.source.test(file) || file.split(/[\\/]/).includes("__pycache__")) continue;
		const content = readFileSync(join(to, file), "utf8");
		const next = content.replaceAll(`${base}@${latest}`, `${base}@${latest + 1}`);
		if (next !== content) writeFileSync(join(to, file), next);
	}
	const shown = relative(process.cwd(), to);
	const text = `Created ${base}@${latest + 1} in ${shown}, as a copy of version ${latest}.\nVersion ${latest} is untouched, and the workflows that use it keep working.`;
	return { ok: true, text, data: { ok: true, id: `${base}@${latest + 1}`, folder: shown } };
}

export function newWorkflow(paths: Paths, name: string, options: { json?: boolean; trigger?: string } = {}): Report {
	if (!SEGMENT.test(name)) return fail(`"${name}" is not a workflow name. Use lower case, such as place-order.`);
	const trigger = (options.trigger ?? "http") as TriggerKind;
	if (!TRIGGERS.includes(trigger)) {
		return fail(
			`"${options.trigger}" cannot start a workflow. Use ${TRIGGERS.join(", ").replace(/, ([^,]*)$/, " or $1")}.`,
		);
	}
	for (const ending of ["pkl", "json"]) {
		if (existsSync(join(paths.workflows, `${name}.${ending}`)))
			return fail(`workflows/${name}.${ending} already exists.`);
	}
	const file = join(paths.workflows, `${name}.${options.json ? "json" : "pkl"}`);
	add(file, options.json ? workflowJson(name, trigger) : workflowPkl(name, trigger));
	const shown = relative(process.cwd(), file);
	const text = `Created ${shown}. It has no steps yet, so "blokctl check" will ask for some.`;
	return { ok: true, text, data: { ok: true, id: `workflows/${name}@1`, file: shown } };
}

export { locate };
