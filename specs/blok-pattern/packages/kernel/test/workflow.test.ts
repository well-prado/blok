// What phase 1 added to the runner and the check: a workflow's request shape, and a workflow as a typed step.
// The behaviour of steps, branches, loops and the rest of the check is covered by the example app's tests.
import { expect, test } from "bun:test";
import { join } from "node:path";
import Fastify from "fastify";
import { z } from "zod";
import { blokFastify, mount } from "../src/fastify.ts";
import {
	type Span,
	type Unit,
	type Workflow,
	blok,
	checkWorkflow,
	checkWorkflows,
	contract,
	httpBinding,
	loadProject,
	loadWorkflows,
} from "../src/index.ts";

const { node, runtime } = blok<{ log: string[] }>();

const reserve = node({
	id: "stock/reserve@1",
	input: z.object({ sku: z.string(), qty: z.number().int().default(1) }),
	output: z.object({ reservation: z.string() }),
	run: ({ sku }, { ports }) => {
		ports.log.push(`reserve ${sku}`);
		return { reservation: `res_${sku}` };
	},
});
const charge = node({
	id: "billing/charge@1",
	input: z.object({ token: z.string(), reservation: z.string() }),
	output: z.object({ receipt: z.string() }),
	run: ({ token }, { ports }) => {
		ports.log.push(`charge ${token}`);
		return { receipt: `rc_${token}` };
	},
});
const notify = node({
	id: "mail/notify@1",
	input: z.object({ to: z.string(), text: z.string() }),
	output: z.object({ sent: z.boolean() }),
	run: () => ({ sent: true }),
});
const nodes = () => new Map<string, Unit>([reserve, charge, notify].map((unit) => [unit.id, unit]));
const shapes = (id: string) => {
	const unit = nodes().get(id);
	return unit ? { input: contract(unit).input as object, output: contract(unit).output as object } : undefined;
};

const buy: Workflow = {
	name: "Buy",
	trigger: { http: { method: "POST", path: "/shops/:shop/buy" } },
	steps: [
		{ name: "hold", node: "stock/reserve@1", inputs: { sku: "${request.body.sku}", qty: "${request.body.qty}" } },
		{
			name: "pay",
			node: "billing/charge@1",
			inputs: { token: "${request.body.token}", reservation: "${hold.reservation}" },
		},
		{
			name: "mail",
			node: "mail/notify@1",
			if: "${request.body.notify} == true",
			inputs: { to: "${request.body.email}", text: "Thanks from shop ${request.params.shop}" },
		},
	],
	result: { receipt: "${pay.receipt}", coupon: "${request.query.coupon}" },
};

test("a workflow's request shape is not written down: it follows from the inputs its fields are wired into", () => {
	const { problems, request } = checkWorkflow(buy, shapes);
	expect(problems).toEqual([]);
	expect(request.properties?.body).toEqual({
		type: "object",
		// `sku` and `token` feed required inputs of steps that always run.
		// `qty` has a default in the node, and `notify` and `email` belong to a step that may be skipped.
		required: ["sku", "token"],
		properties: {
			sku: { type: "string" },
			qty: { type: "integer" },
			token: { type: "string" },
			notify: { type: "boolean" },
			email: { type: "string" },
		},
	});
	expect(Object.keys(request.properties?.params?.properties ?? {})).toEqual(["shop"]);
	expect(Object.keys(request.properties?.query?.properties ?? {})).toEqual(["coupon"]);
});

test("a request that lacks a field a step is certain to need is refused before any step has run", async () => {
	const units = nodes();
	const [unit] = loadWorkflows([{ id: "workflows/buy@1", workflow: buy }], units);
	const log: string[] = [];
	const spans: Span[] = [];
	const { call } = runtime({ ports: { log }, onSpan: (span) => spans.push(span) });

	// `token` is first needed by the second step. Without this, the stock would already be reserved when it fails.
	const err = await call(unit, { body: { sku: "desk" }, params: { shop: "s1" }, query: {} }).catch((e) => e);
	expect(err).toMatchObject({ code: "invalid_input", message: "The request is missing: body.token." });
	expect(log).toEqual([]);
	expect(spans.map((span) => span.id)).toEqual(["workflows/buy@1"]);

	// `qty`, `notify` and `email` are not demanded: one has a default, the others belong to a step that may be skipped.
	const ok = await call(unit, { body: { sku: "desk", token: "tok" }, params: { shop: "s1" }, query: {} });
	expect(ok).toEqual({ receipt: "rc_tok", coupon: undefined });
	expect(log).toEqual(["reserve desk", "charge tok"]);
});

test("the check refuses a request field wired into two kinds, and a path parameter the path does not have", () => {
	const clash = structuredClone(buy);
	(clash.steps[2] as { inputs: Record<string, string> }).inputs.to = "${request.body.qty}";
	expect(checkWorkflow(clash, shapes).problems).toEqual([
		'step "mail", input "to": ${request.body.qty} is needed as string here and as integer in another step.',
	]);

	const noParam = structuredClone(buy);
	(noParam.trigger as { http: { path: string } }).http.path = "/buy";
	expect(checkWorkflow(noParam, shapes).problems).toEqual([
		'step "mail", input "text": ${request.params.shop} reads a path parameter, but the path "/buy" has no ":shop".',
	]);
});

test("a workflow used as a step is checked like a node: its inputs are what it reads from its request body", () => {
	const gift = (inputs: Record<string, string>): Workflow => ({
		name: "Gift",
		steps: [{ name: "bought", node: "workflows/buy@1", inputs }],
		result: { receipt: "${bought.receipt}" },
	});
	const check = (inputs: Record<string, string>) =>
		checkWorkflows(
			[
				{ id: "workflows/gift@1", workflow: gift(inputs) },
				{ id: "workflows/buy@1", workflow: buy },
			],
			nodes(),
		);

	const good = check({ sku: "${request.body.sku}", token: "${request.body.card}" });
	expect(good.problems).toEqual([]);
	// What the caller needs follows through the workflow it calls.
	expect(good.shapes.get("workflows/gift@1")?.input).toMatchObject({ required: ["sku", "card"] });
	expect(good.shapes.get("workflows/gift@1")?.output).toMatchObject({ properties: { receipt: { type: "string" } } });

	expect(check({ sku: "${request.body.sku}", tokn: "t", qty: "${request.body.sku}" }).problems).toEqual([
		'workflows/gift@1: step "bought": "workflows/buy@1" has no input "tokn". It takes: sku, qty, token, notify, email.',
		'workflows/gift@1: step "bought", input "qty": ${request.body.sku} is needed as integer here and as string in another step.',
		'workflows/gift@1: step "bought": "workflows/buy@1" needs input "token".',
	]);
});

test("every error a workflow can fail with needs a status, or the caller would get a 500 with no reason", () => {
	const refund = node({
		id: "billing/refund@1",
		input: z.object({ receipt: z.string() }),
		output: z.object({ refunded: z.boolean() }),
		errors: ["already_refunded", "too_old"],
		run: () => ({ refunded: true }),
	});
	const all = new Map([...nodes(), [refund.id, refund]]);
	const undo = (errors?: Record<string, number>): Workflow => ({
		name: "Undo",
		trigger: { http: { method: "POST", path: "/undo", errors } },
		steps: [{ name: "refund", node: "billing/refund@1", inputs: { receipt: "${request.body.receipt}" } }],
	});
	const check = (workflows: Array<{ id: string; workflow: Workflow }>) => checkWorkflows(workflows, all).problems;

	expect(check([{ id: "workflows/undo@1", workflow: undo({ already_refunded: 409 }) }])).toEqual([
		'workflows/undo@1: step "refund" can fail with "too_old", and the trigger gives that no status, so a caller would get a 500. Give "too_old" a status in the trigger\'s errors.',
	]);
	expect(check([{ id: "workflows/undo@1", workflow: undo({ already_refunded: 409, too_old: 410 }) }])).toEqual([]);

	// A workflow with no trigger answers nobody directly. Its errors pass to the workflow that uses it as a step.
	const inner: Workflow = { name: "Inner", steps: undo().steps };
	const outer: Workflow = {
		name: "Outer",
		trigger: { http: { method: "POST", path: "/outer", errors: { too_old: 410 } } },
		steps: [{ name: "inner", node: "workflows/inner@1", inputs: { receipt: "${request.body.receipt}" } }],
	};
	expect(
		check([
			{ id: "workflows/outer@1", workflow: outer },
			{ id: "workflows/inner@1", workflow: inner },
		]),
	).toEqual([
		'workflows/outer@1: step "inner" can fail with "already_refunded", and the trigger gives that no status, so a caller would get a 500. Give "already_refunded" a status in the trigger\'s errors.',
	]);
});

// ---- from disk ---------------------------------------------------------------------------

const fixture = join(import.meta.dirname, "fixture");
const built = join(fixture, "built");

test("loadProject finds the nodes by their folders and the workflows by their built JSON", async () => {
	const project = await loadProject({ dir: fixture, workflows: built });
	expect([...project.units.keys()]).toEqual([
		"demo/double@1",
		"demo/later@1",
		"workflows/double@1",
		"workflows/later@1",
	]);
	expect(project.bindings.map((binding) => `${binding.method} ${binding.path}`)).toEqual([
		"POST /double/:times",
		"GET /later",
	]);

	// Nothing built yet is the first thing a new user meets, so it says what to run.
	expect(loadProject({ dir: fixture })).rejects.toThrow(/There are no built workflows at .*Run "blokctl build" first/);
});

test("a node whose id disagrees with its folder is refused, and so is a node file in the wrong place", async () => {
	const { discoverNodes } = await import("../src/index.ts");
	expect(discoverNodes(join(fixture, "nodes", "demo"))).rejects.toThrow(
		"double/v1/node.ts is not where a node goes. A node lives at <module>/<node>/v<N>/node.ts.",
	);
	expect(await discoverNodes(join(fixture, "nowhere"))).toEqual(new Map());
});

test("one register line mounts every HTTP trigger, and errors become statuses", async () => {
	const seen: number[] = [];
	const app = Fastify();
	await app.register(blokFastify, { dir: fixture, workflows: built, ports: { seen } });

	const ok = await app.inject({ method: "POST", url: "/double/3", payload: { n: 21 } });
	expect(ok.statusCode).toBe(200);
	expect(ok.json()).toEqual({ n: 42, times: "3" });
	expect(seen).toEqual([21]);

	// A status the workflow's trigger maps.
	const unlucky = await app.inject({ method: "POST", url: "/double/3", payload: { n: 13 } });
	expect(unlucky.statusCode).toBe(422);
	expect(unlucky.json()).toEqual({ error: "unlucky", message: "Thirteen is refused.", node: "demo/double@1" });

	// A missing field is refused by the workflow, a wrong kind by the node. Both are the caller's mistake.
	const missing = await app.inject({ method: "POST", url: "/double/3", payload: {} });
	expect(missing.statusCode).toBe(400);
	expect(missing.json()).toMatchObject({ node: "workflows/double@1", message: "The request is missing: body.n." });
	const wrong = await app.inject({ method: "POST", url: "/double/3", payload: { n: "x" } });
	expect(wrong.statusCode).toBe(400);
	expect(wrong.json().node).toBe("demo/double@1");

	// A node that is still `todo` answers 501, so a half-built app can run.
	const later = await app.inject({ method: "GET", url: "/later" });
	expect(later.statusCode).toBe(501);
	expect(later.json()).toMatchObject({ error: "not_implemented", node: "demo/later@1" });
});

test("mount serves one binding on a server you already have", async () => {
	const units = nodes();
	const [unit] = loadWorkflows([{ id: "workflows/buy@1", workflow: buy }], units);
	const app = Fastify();
	app.get("/health", () => ({ ok: true }));
	const binding = httpBinding(buy, unit);
	if (!binding) throw new Error("buy has an HTTP trigger");
	mount(app, binding, runtime({ ports: { log: [] } }).call);
	expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ ok: true });
	const res = await app.inject({
		method: "POST",
		url: "/shops/s1/buy?coupon=TEN",
		payload: { sku: "desk", token: "tok" },
	});
	expect(res.json()).toEqual({ receipt: "rc_tok", coupon: "TEN" });
});
