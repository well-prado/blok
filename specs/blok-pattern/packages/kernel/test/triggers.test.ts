// What starts a workflow besides HTTP: a schedule, a queue message, and an agent calling it as a tool.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { type Timers, startCron } from "../src/cron.ts";
import {
	type App,
	type Unit,
	type Workflow,
	bindingsOf,
	blok,
	checkWorkflow,
	checkWorkflows,
	contract,
	loadApp,
	loadChecked,
} from "../src/index.ts";
import { blokMcp } from "../src/mcp.ts";
import { type Refused, memoryQueue, startQueues } from "../src/queue.ts";

interface Ports {
	seen: unknown[];
	/** A run waits on this when it is there, so a test can hold one open. */
	gate?: Promise<void>;
	/** How many more times `shop/flaky` fails before it works. */
	failures: number;
}
const { node, runtime } = blok<Ports>();

const restock = node({
	id: "shop/restock@1",
	description: "Orders more of a product for a region.",
	input: z.object({ region: z.string(), limit: z.number().int().default(10) }),
	output: z.object({ ordered: z.number().int() }),
	errors: { unknown_region: "The region is not one the shop sells in." },
	async run({ region, limit }, { ports, fail }) {
		if (region === "mars") throw fail("unknown_region", "Nothing is sold on Mars.");
		ports.seen.push({ region, limit });
		await ports.gate;
		return { ordered: limit };
	},
});
const flaky = node({
	id: "shop/flaky@1",
	input: z.object({ id: z.string() }),
	output: z.object({ id: z.string() }),
	run({ id }, { ports }) {
		ports.seen.push(id);
		if (ports.failures-- > 0) throw new Error("the database dropped the connection");
		return { id };
	},
});
const all = [restock, flaky];
const nodes = () => new Map<string, Unit>(all.map((unit) => [unit.id, unit]));
const shapes = (id: string) => {
	const unit = nodes().get(id);
	const described = unit && contract(unit);
	return (
		described && { input: described.input as object, output: described.output as object, errors: described.errors }
	);
};

const restockStep = (inputs: Record<string, string | number>) => ({ name: "restock", node: "shop/restock@1", inputs });
const nightly: Workflow = {
	name: "Nightly restock",
	description: "Orders more of what is running low.",
	trigger: { cron: { schedule: "0 2 * * *", body: { region: "eu", limit: 25 } } },
	steps: [restockStep({ region: "${request.body.region}", limit: "${request.body.limit}" })],
};

/** A loaded app made of these workflows, with what it logged and what its nodes saw. */
function load(workflows: Record<string, Workflow>, ports: Partial<Ports> = {}) {
	const units = nodes();
	const list = Object.entries(workflows).map(([name, workflow]) => ({ id: `workflows/${name}@1`, workflow }));
	const { shapes } = loadChecked(list, units);
	const bindings = list.flatMap(({ id, workflow }) => bindingsOf(id, workflow, units.get(id) as Unit, shapes.get(id)));
	const logged: string[] = [];
	const log = { info() {}, error: (message: string) => void logged.push(message) };
	const held: Ports = { seen: [], failures: 0, ...ports };
	const app: App = { units, workflows: list, shapes, bindings, log, call: runtime({ ports: held, log }).call };
	return { app, logged, ports: held };
}

// ---- the check ---------------------------------------------------------------------------

test("the check knows what each trigger can hand a workflow", () => {
	expect(checkWorkflow(nightly, shapes).problems).toEqual([]);

	// Nobody sends a schedule its body. What the steps need has to be written in the trigger.
	const empty = structuredClone(nightly);
	(empty.trigger as { cron: { body?: unknown } }).cron.body = { limit: 25 };
	expect(checkWorkflow(empty, shapes).problems).toEqual([
		"The schedule starts it with a body that lacks: region. Write it in the cron trigger's body.",
	]);
	const wrong = structuredClone(nightly);
	(wrong.trigger as { cron: { body?: unknown } }).cron.body = { region: "eu", limit: "many" };
	expect(checkWorkflow(wrong, shapes).problems).toEqual([
		"The cron trigger's body does not fit what the steps read. In it, limit is string, and integer is needed.",
	]);

	const schedule = (text: string, timezone?: string) =>
		checkWorkflow({ ...nightly, trigger: { cron: { schedule: text, timezone, body: { region: "eu" } } } }, shapes)
			.problems;
	expect(schedule("0 25 * * *")).toEqual(['The schedule "0 25 * * *" cannot be read: hour 25 is outside 0-23.']);
	expect(schedule("every night")).toEqual([
		'The schedule "every night" cannot be read: it has 2 parts, and a schedule has five: minute, hour, day of month, month, day of week.',
	]);
	expect(schedule("0 0 31 2 *")).toEqual(['The schedule "0 0 31 2 *" never happens.']);
	expect(schedule("0 2 * * *", "Lisbon")).toEqual([
		'"Lisbon" is not a time zone. Use a name such as "Europe/Lisbon", or leave it out for UTC.',
	]);
	expect(schedule("0 2 * * *", "Europe/Lisbon")).toEqual([]);

	// Only an HTTP request has a query, path parameters and headers.
	const reads = (trigger: Workflow["trigger"]) =>
		checkWorkflow(
			{
				name: "Reads",
				description: "Reads a query.",
				trigger,
				steps: [restockStep({ region: "${request.query.region}" })],
			},
			shapes,
		).problems;
	expect(reads({ http: { method: "GET", path: "/restock", errors: { unknown_region: 404 } } })).toEqual([]);
	expect(reads({ queue: { name: "restock" } })).toEqual([
		"It is started by a queue message, which hands it a body and nothing else, but a step needs ${request.query.region}. Read it from the body.",
	]);
	expect(reads({ mcp: {} })).toEqual([
		"It is started by an agent calling it as a tool, which hands it a body and nothing else, but a step needs ${request.query.region}. Read it from the body.",
	]);

	// A tool is chosen by its description.
	const tool = (workflow: Partial<Workflow>) =>
		checkWorkflow({ name: "Tool", steps: [restockStep({ region: "${request.body.region}" })], ...workflow }, shapes)
			.problems;
	expect(tool({ trigger: { mcp: {} } })).toEqual([
		"It is a tool for agents and has no description, and the description is how an agent chooses a tool. Give the workflow a description.",
	]);
	expect(tool({ trigger: { mcp: { description: "Orders more stock." } } })).toEqual([]);
	expect(tool({ description: "Orders more stock.", trigger: { mcp: { tool: "restock now!" } } })).toEqual([
		'"restock now!" cannot be a tool name. Use letters, digits, "_" and "-", 64 at most.',
	]);
});

test("a route, a queue and a tool name each belong to one workflow", () => {
	const step = [restockStep({ region: "${request.body.region}" })];
	const errors = { unknown_region: 404 };
	const make = (trigger: Workflow["trigger"]): Workflow => ({
		name: "W",
		description: "Orders more stock.",
		trigger,
		steps: step,
	});
	const { problems } = checkWorkflows(
		[
			{ id: "workflows/a@1", workflow: make({ http: { method: "POST", path: "/regions/:id/restock", errors } }) },
			{ id: "workflows/b@1", workflow: make({ http: { method: "POST", path: "/regions/:region/restock", errors } }) },
			// The same path with another method is another route.
			{ id: "workflows/c@1", workflow: make({ http: { method: "PUT", path: "/regions/:id/restock", errors } }) },
			{ id: "workflows/d@1", workflow: make({ queue: { name: "restock" } }) },
			{ id: "workflows/e@1", workflow: make({ queue: { name: "restock" } }) },
			{ id: "workflows/restock-now@1", workflow: make({ mcp: {} }) },
			{ id: "workflows/g@1", workflow: make({ mcp: { tool: "restock_now" } }) },
		],
		nodes(),
	);
	expect(problems).toEqual([
		"workflows/a@1 and workflows/b@1 both answer POST /regions/:region/restock. A route belongs to one workflow.",
		'workflows/d@1 and workflows/e@1 both read the queue "restock". A queue belongs to one workflow.',
		'workflows/restock-now@1 and workflows/g@1 are both the tool "restock_now". A tool name belongs to one workflow.',
	]);
});

// ---- a schedule --------------------------------------------------------------------------

/** A clock that only moves when the test moves it. */
function clock(start: string) {
	let now = Date.parse(start);
	let waiting: Array<{ at: number; run: () => void }> = [];
	const settle = async () => {
		for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done));
	};
	const timers: Timers = {
		now: () => now,
		set(run, ms) {
			const timer = { at: now + ms, run };
			waiting.push(timer);
			return timer;
		},
		clear(timer) {
			waiting = waiting.filter((one) => one !== timer);
		},
	};
	return {
		timers,
		waiting: () => waiting.length,
		/** Moves time forward, firing every timer that comes due on the way, in order. */
		async advance(ms: number) {
			const end = now + ms;
			for (;;) {
				const due = waiting.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
				if (!due) break;
				waiting = waiting.filter((timer) => timer !== due);
				now = due.at;
				due.run();
				await settle();
			}
			now = end;
		},
	};
}
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

test("a cron trigger runs its workflow on the schedule, with the body the trigger gives it", async () => {
	const { app, ports, logged } = load({ nightly });
	const time = clock("2026-03-10T01:58:30Z");
	const runs: string[] = [];
	const cron = await startCron(app, {
		timers: time.timers,
		onRun: (run) => runs.push(`${run.at.toISOString()} ${run.ok}`),
	});
	expect(cron.jobs.map((job) => [job.id, job.schedule, job.timezone, job.next().toISOString()])).toEqual([
		["workflows/nightly@1", "0 2 * * *", "UTC", "2026-03-10T02:00:00.000Z"],
	]);

	await time.advance(MINUTE);
	expect(ports.seen).toEqual([]);
	await time.advance(MINUTE);
	expect(ports.seen).toEqual([{ region: "eu", limit: 25 }]);
	expect(cron.jobs[0].next().toISOString()).toBe("2026-03-11T02:00:00.000Z");
	await time.advance(2 * DAY);
	expect(runs).toEqual([
		"2026-03-10T02:00:00.000Z true",
		"2026-03-11T02:00:00.000Z true",
		"2026-03-12T02:00:00.000Z true",
	]);
	expect(logged).toEqual([]);

	await cron.stop();
	expect(time.waiting()).toBe(0);
	await time.advance(2 * DAY);
	expect(runs).toHaveLength(3);
});

test("a run that fails is written to the log, and the schedule goes on", async () => {
	const failing: Workflow = { ...nightly, trigger: { cron: { schedule: "*/10 * * * *", body: { region: "mars" } } } };
	const { app, logged } = load({ failing });
	const time = clock("2026-03-10T00:00:00Z");
	const runs: string[] = [];
	const cron = await startCron(app, { timers: time.timers, onRun: (run) => runs.push(`${run.ok} ${run.error}`) });
	await time.advance(20 * MINUTE);
	expect(runs).toEqual(["false unknown_region", "false unknown_region"]);
	expect(logged).toEqual([
		'workflows/failing@1, started by its schedule, failed with "unknown_region" at shop/restock@1: Nothing is sold on Mars.',
		'workflows/failing@1, started by its schedule, failed with "unknown_region" at shop/restock@1: Nothing is sold on Mars.',
	]);
	await cron.stop();
});

test("a run that is still going is not joined by a second one, and stop waits for it", async () => {
	let open: () => void = () => {};
	const gate = new Promise<void>((done) => {
		open = done;
	});
	const slow: Workflow = { ...nightly, trigger: { cron: { schedule: "* * * * *", body: { region: "eu" } } } };
	const { app, ports, logged } = load({ slow }, { gate });
	const time = clock("2026-03-10T00:00:30Z");
	const runs: string[] = [];
	const cron = await startCron(app, {
		timers: time.timers,
		onRun: (run) => runs.push(`${run.at.toISOString().slice(14, 19)} ${run.error ?? "ok"}`),
	});
	await time.advance(3 * MINUTE);
	expect(ports.seen).toHaveLength(1);
	expect(runs).toEqual(["02:00 skipped", "03:00 skipped"]);
	expect(logged[0]).toBe(
		"workflows/slow@1 was not started at 2026-03-10T00:02:00.000Z: the run before it is still going.",
	);

	let stopped = false;
	const stopping = cron.stop().then(() => {
		stopped = true;
	});
	await new Promise((done) => setImmediate(done));
	expect(stopped).toBe(false);
	open();
	await stopping;
	expect(runs).toEqual(["02:00 skipped", "03:00 skipped", "01:00 ok"]);
});

test("a job further away than a timer can wait is looked at again, and does not run early", async () => {
	const yearly: Workflow = { ...nightly, trigger: { cron: { schedule: "0 0 1 1 *", body: { region: "eu" } } } };
	const { app, ports } = load({ yearly });
	const time = clock("2026-03-10T00:00:00Z");
	const cron = await startCron(app, { timers: time.timers });
	await time.advance(200 * DAY);
	expect(ports.seen).toEqual([]);
	expect(time.waiting()).toBe(1);
	await time.advance(100 * DAY);
	expect(ports.seen).toEqual([{ region: "eu", limit: 10 }]);
	await cron.stop();
});

// ---- a queue -----------------------------------------------------------------------------

const onMessage: Workflow = {
	name: "Restock on message",
	trigger: { queue: { name: "restock", concurrency: 2 } },
	steps: [restockStep({ region: "${request.body.region}" })],
};

test("a queue trigger runs its workflow once per message, and a refused message is not sent again", async () => {
	const { app, ports, logged } = load({ "on-message": onMessage });
	const queue = memoryQueue();
	const refused: Refused[] = [];
	// A message can be sent before anything listens. It waits.
	queue.send("restock", { region: "eu" });
	const started = await startQueues(app, { subscribe: queue.subscribe, onRefused: (one) => void refused.push(one) });
	expect(started.queues).toEqual(["restock"]);
	queue.send("restock", { region: "us" });
	queue.send("restock", { region: "mars" });
	queue.send("restock", { where: "nowhere" });
	await queue.idle();

	expect(ports.seen).toEqual([
		{ region: "eu", limit: 10 },
		{ region: "us", limit: 10 },
	]);
	// A business error and a message that lacks a field are refusals: trying again would be refused again.
	// Two messages are handled at a time, so the order they finish in is not promised.
	const said = refused.map((one) => [one.queue, one.id, one.message, one.error.code, one.error.message]);
	expect(said.sort((a, b) => String(a[3]).localeCompare(String(b[3])))).toEqual([
		[
			"restock",
			"workflows/on-message@1",
			{ where: "nowhere" },
			"invalid_input",
			"The request is missing: body.region.",
		],
		["restock", "workflows/on-message@1", { region: "mars" }, "unknown_region", "Nothing is sold on Mars."],
	]);
	expect(queue.dead).toEqual([]);
	expect(logged).toEqual([]);

	// After stop, nothing listens, and a message waits again.
	await started.stop();
	queue.send("restock", { region: "asia" });
	await queue.idle();
	expect(ports.seen).toHaveLength(2);
});

test("a message that fails for a reason of the machine's is handed over again, and given up on in the end", async () => {
	const work: Workflow = {
		name: "Work",
		trigger: { queue: { name: "work" } },
		steps: [{ name: "job", node: "shop/flaky@1", inputs: { id: "${request.body.id}" } }],
	};
	const { app, ports, logged } = load({ work }, { failures: 2 });
	const queue = memoryQueue({ attempts: 3 });
	await startQueues(app, { subscribe: queue.subscribe });
	queue.send("work", { id: "a" });
	await queue.idle();
	// It failed twice and worked the third time.
	expect(ports.seen).toEqual(["a", "a", "a"]);
	expect(queue.dead).toEqual([]);
	expect(logged).toEqual(
		Array(2).fill(
			'workflows/work@1, on a message from "work", failed with "unexpected" at shop/flaky@1: the database dropped the connection',
		),
	);

	ports.failures = 99;
	queue.send("work", { id: "b" });
	await queue.idle();
	expect(ports.seen.filter((id) => id === "b")).toHaveLength(3);
	expect(queue.dead.map((one) => [one.queue, one.message])).toEqual([["work", { id: "b" }]]);
});

test("with no place to put a refused message, it is written to the log and dropped", async () => {
	const { app, logged } = load({ "on-message": onMessage });
	const queue = memoryQueue();
	await startQueues(app, { subscribe: queue.subscribe });
	queue.send("restock", { region: "mars" });
	await queue.idle();
	expect(logged).toEqual([
		'workflows/on-message@1, on a message from "restock", failed with "unknown_region" at shop/restock@1: Nothing is sold on Mars. The message was dropped: sending it again would be refused again.',
	]);
});

test("the queue runs as many messages at once as the trigger allows", async () => {
	let open: () => void = () => {};
	const gate = new Promise<void>((done) => {
		open = done;
	});
	const { app, ports } = load({ "on-message": onMessage }, { gate });
	const queue = memoryQueue();
	await startQueues(app, { subscribe: queue.subscribe });
	for (const region of ["a", "b", "c", "d"]) queue.send("restock", { region });
	await new Promise((done) => setImmediate(done));
	// Two at a time: the third waits for one of the first two.
	expect(ports.seen).toHaveLength(2);
	open();
	await queue.idle();
	expect(ports.seen).toHaveLength(4);
});

// ---- a tool for agents -------------------------------------------------------------------

test("an mcp trigger makes the workflow a tool that the official MCP client can list and call", async () => {
	const tool: Workflow = {
		name: "Restock",
		description: "Orders more of a product for a region.",
		trigger: { mcp: {} },
		steps: [restockStep({ region: "${request.body.region}", limit: "${request.body.limit}" })],
	};
	const work: Workflow = {
		name: "Work",
		trigger: { mcp: { tool: "do_work", description: "Does one piece of work." } },
		steps: [{ name: "job", node: "shop/flaky@1", inputs: { id: "${request.body.id}" } }],
		result: "${job.id}",
	};
	const { app, ports, logged } = load({ "restock-region": tool, work }, { failures: 1 });
	const server = await blokMcp(app, { name: "shop", version: "1.2.3", instructions: "Tools for the shop." });
	const client = new Client({ name: "test", version: "1.0.0" });
	const [near, far] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(far), client.connect(near)]);
	expect(client.getServerVersion()).toMatchObject({ name: "shop", version: "1.2.3" });
	expect(client.getInstructions()).toBe("Tools for the shop.");

	// The arguments are what the workflow reads from its body, worked out from the nodes. Nobody wrote them down.
	const { tools } = await client.listTools();
	expect(tools.map((one) => [one.name, one.description])).toEqual([
		["restock_region", "Orders more of a product for a region."],
		["do_work", "Does one piece of work."],
	]);
	expect(tools[0].inputSchema).toMatchObject({
		type: "object",
		properties: { region: { type: "string" }, limit: { type: "integer" } },
		required: ["region"],
	});
	expect(tools[0].outputSchema).toMatchObject({ type: "object", properties: { ordered: { type: "integer" } } });
	// An answer that is not an object promises no shape.
	expect(tools[1].outputSchema).toBeUndefined();

	const ok = await client.callTool({ name: "restock_region", arguments: { region: "eu", limit: 5 } });
	expect(ok).toMatchObject({ content: [{ type: "text", text: '{"ordered":5}' }], structuredContent: { ordered: 5 } });
	expect(ok.isError).toBeFalsy();
	expect(ports.seen).toEqual([{ region: "eu", limit: 5 }]);

	// A refusal reaches the agent in words it can act on.
	expect(await client.callTool({ name: "restock_region", arguments: { region: "mars" } })).toMatchObject({
		isError: true,
		content: [{ type: "text", text: "unknown_region: Nothing is sold on Mars." }],
	});
	expect(await client.callTool({ name: "restock_region", arguments: {} })).toMatchObject({
		isError: true,
		content: [{ type: "text", text: "invalid_input: The request is missing: body.region." }],
	});
	// What broke inside stays inside.
	expect(await client.callTool({ name: "do_work", arguments: { id: "a" } })).toMatchObject({
		isError: true,
		content: [{ type: "text", text: "unexpected: The tool could not complete the call." }],
	});
	expect(logged).toEqual([
		'workflows/work@1, called as the tool "do_work", failed with "unexpected" at shop/flaky@1: the database dropped the connection',
	]);
	expect(await client.callTool({ name: "do_work", arguments: { id: "b" } })).toMatchObject({
		content: [{ type: "text", text: '"b"' }],
	});
	expect(await client.callTool({ name: "nothing", arguments: {} })).toMatchObject({
		isError: true,
		content: [{ type: "text", text: 'There is no tool called "nothing".' }],
	});
	await client.close();
});

// ---- from disk ---------------------------------------------------------------------------

test("loadApp loads a project once, with every trigger as a binding and a `call` to run them", async () => {
	const fixture = join(import.meta.dirname, "fixture");
	const seen: number[] = [];
	const app = await loadApp({ dir: fixture, workflows: join(fixture, "built"), ports: { seen } });
	expect(
		app.bindings.map((binding) =>
			binding.kind === "http"
				? `http ${binding.method} ${binding.path}`
				: binding.kind === "cron"
					? `cron ${binding.schedule} ${binding.timezone} ${JSON.stringify(binding.body)}`
					: binding.kind === "queue"
						? `queue ${binding.queue}`
						: `mcp ${binding.tool}`,
		),
	).toEqual([
		"http POST /double/:times",
		"queue numbers",
		"http GET /later",
		'cron 30 6 * * mon-fri Europe/Lisbon {"n":21}',
		"mcp twice",
	]);
	// One workflow, started three ways.
	const twice = app.units.get("workflows/twice@1") as Unit;
	expect(await app.call(twice, { body: { n: 4 } })).toEqual({ n: 8 });
	expect(seen).toEqual([4]);
});
