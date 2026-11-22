import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Entry,
	type Span,
	type Step,
	type Unit,
	type Workflow,
	checkWorkflow,
	contract,
	discoverNodes,
	httpBinding,
	loadWorkflows,
} from "@blokjs/kernel";
import { mount } from "@blokjs/kernel/fastify";
import { Ajv2020 } from "ajv/dist/2020.js";
import { analyze, locate } from "blokctl";
import Fastify from "fastify";
import { runtime } from "#blok";
import type { Ports } from "#ports";
import { fakePorts } from "../app.ts";

const root = join(import.meta.dirname, "..");
// Workflows are written in Pkl. This does what `blokctl check` does: it regenerates the typed steps
// from the node contracts, evaluates every .pkl file into the JSON the runner loads, and checks it.
const analysis = await analyze(locate(root));
if (analysis.problems.length > 0) throw new Error(analysis.problems.join("\n"));
const files = analysis.workflows;
const definition = (name: string) => structuredClone(files.find((f) => f.file === `${name}.pkl`)?.workflow as Workflow);

/** Loads the nodes from disk and registers the workflows beside them. */
async function load(extra: Array<{ id: string; workflow: Workflow }> = []) {
	const units = await discoverNodes(join(root, "nodes"));
	loadWorkflows([...files, ...extra], units);
	return units;
}
async function start(ports: Ports = fakePorts(), onSpan?: (span: Span) => void) {
	const units = await load();
	const { call } = runtime({ ports, onSpan });
	const app = Fastify();
	for (const { id, workflow } of files) {
		const binding = httpBinding(workflow, units.get(id) as Unit);
		if (binding) mount(app, binding, call);
	}
	return { app, call, unit: (id: string) => units.get(id) as Unit };
}
const order = { customerId: "c_1", items: [{ sku: "sku-book", qty: 2 }], token: "tok_ok" };
const desk = { ...order, items: [{ sku: "sku-desk", qty: 1 }] };

test("every example is valid against workflow.schema.json, and the schema can say no", () => {
	const schema = join(root, "..", "packages", "cli", "assets", "workflow.schema.json");
	const validate = new Ajv2020().compile(JSON.parse(readFileSync(schema, "utf8")));
	for (const { file, workflow } of files) expect(`${file}: ${validate(workflow)}`).toBe(`${file}: true`);
	expect(files).toHaveLength(10);

	const oldStyle = definition("countries");
	Object.assign(oldStyle.steps[0], { type: "module" });
	expect(validate(oldStyle)).toBe(false);
	expect(validate({ name: "x", step: [] })).toBe(false);
	// The separate `nodes` block is gone: a step's inputs live in the step.
	expect(validate({ ...definition("countries"), nodes: { "get-countries": { inputs: {} } } })).toBe(false);
});

test("all ten workflows load and pass the check against the node contracts", async () => {
	const units = await load();
	expect(files.map((f) => f.id)).toEqual([
		"workflows/catalog-sync@1",
		"workflows/checkout@1",
		"workflows/countries-vs-facts@1",
		"workflows/countries@1",
		"workflows/feedback-create@1",
		"workflows/feedback-list@1",
		"workflows/fulfil-batch@1",
		"workflows/fulfil@1",
		"workflows/place-order@1",
		"workflows/quote@1",
	]);
	expect(units.size).toBe(15 + 10);
});

// ---- the original's own examples, converted ---------------------------------------------

test("countries: one step, and the answer is that step's result", async () => {
	const { app } = await start();
	const res = await app.inject({ method: "GET", url: "/countries" });
	expect(res.statusCode).toBe(200);
	expect(res.json()).toEqual({ status: 200, data: { from: "https://countriesnow.space/api/v0.1/countries/capital" } });
});

test("countries-vs-facts: `conditions` picks a branch and the answer is whichever step ran", async () => {
	const { app } = await start();
	const countries = await app.inject({ method: "GET", url: "/countries-or-facts?countries=true" });
	expect(countries.json().data.from).toBe("https://countriesnow.space/api/v0.1/countries/capital");
	const facts = await app.inject({ method: "GET", url: "/countries-or-facts" });
	expect(facts.json().data.from).toBe("https://catfact.ninja/fact");
});

test("feedback: the original's one routed workflow is two small ones, and text interpolates", async () => {
	const keys: string[] = [];
	const stored: unknown[] = [];
	const kv: Ports["kv"] = {
		set: async (key, value) => {
			keys.push(key);
			stored.push(value);
		},
		list: async () => stored,
	};
	const { app } = await start(fakePorts({ kv }));
	const feedback = { id: "f1", title: "Checkout", comment: "Love it, great and fast" };
	const created = await app.inject({ method: "POST", url: "/feedback", payload: feedback });
	expect(created.json()).toEqual({ ...feedback, sentiment: "positive" });
	expect(keys).toEqual(["feedback:f1"]);
	const listed = await app.inject({ method: "GET", url: "/feedback" });
	expect(listed.json()).toEqual({ items: [{ ...feedback, sentiment: "positive" }] });
});

// ---- the features added to the original shape -------------------------------------------

test("checkout: steps run in order, each one a span keyed by its step name", async () => {
	const spans: Span[] = [];
	const { call, unit } = await start(fakePorts(), (span) => spans.push(span));
	const out = await call(unit("workflows/checkout@1"), { body: order });
	expect(out).toEqual({ orderId: "ord_1", receiptId: "rc_1", totalCents: 50_00 });
	expect(spans.map((s) => `${s.key ?? "-"}:${s.id}`)).toEqual([
		"order:orders/validate-order@1",
		"price:orders/price-order@1",
		"charge:billing/charge-card@1",
		"-:workflows/checkout@1",
	]);
});

test("checkout: a step's `if` compares a value, with no extra node and no code", async () => {
	const flagged: string[] = [];
	const { call, unit } = await start(fakePorts({ crm: { flagVip: async (id) => void flagged.push(id) } }));
	await call(unit("workflows/checkout@1"), { body: order });
	expect(flagged).toEqual([]);
	await call(unit("workflows/checkout@1"), { body: desk });
	expect(flagged).toEqual(["c_1"]);
});

test("checkout: `onError` runs its steps and the workflow still fails with the node's error", async () => {
	const released: string[] = [];
	const { app } = await start(fakePorts({ stock: { release: async (id) => void released.push(id) } }));
	const res = await app.inject({ method: "POST", url: "/orders", payload: { ...order, token: "tok_bad" } });
	expect(res.statusCode).toBe(402);
	expect(res.json()).toMatchObject({ error: "card_declined", node: "billing/charge-card@1" });
	expect(released).toEqual(["ord_1"]);
});

test("quote: `each` runs one step per item, at most `concurrency` at a time, and `${prev}` pipes the list on", async () => {
	let inFlight = 0;
	let peak = 0;
	const catalog: Ports["catalog"] = {
		priceCents: async (sku) => {
			peak = Math.max(peak, ++inFlight);
			await new Promise((done) => setTimeout(done, 5));
			inFlight--;
			return sku === "sku-desk" ? 180_00 : 25_00;
		},
	};
	const { call, unit } = await start(fakePorts({ catalog }));
	const items = [1, 2, 3, 4, 5, 6].map((qty) => ({ sku: qty === 6 ? "sku-desk" : "sku-book", qty }));
	const out = (await call(unit("workflows/quote@1"), { body: { items } })) as { totalCents: number; lineCount: number };
	expect(out.lineCount).toBe(6);
	expect(out.totalCents).toBe(15 * 25_00 + 6 * 180_00);
	expect(peak).toBe(4);
});

test("fulfil: `conditions` with several branches works as a switch, and the first match wins", async () => {
	const { call, unit } = await start();
	const fulfil = unit("workflows/fulfil@1");
	const book = (totalCents: number) => call(fulfil, { body: { orderId: "ord_9", totalCents } });
	expect(await book(2_000_00)).toEqual({ trackingId: "trk_hold_ord_9", lane: "hold" });
	expect(await book(180_00)).toEqual({ trackingId: "trk_courier_ord_9", lane: "courier" });
	expect(await book(50_00)).toEqual({ trackingId: "trk_post_ord_9", lane: "post" });
});

test("fulfil-batch: `each` over a workflow gives a loop whose body has several steps", async () => {
	const spans: Span[] = [];
	const { app } = await start(fakePorts(), (span) => spans.push(span));
	const orders = [
		{ orderId: "a", totalCents: 50_00 },
		{ orderId: "b", totalCents: 180_00 },
		{ orderId: "c", totalCents: 2_000_00 },
	];
	const res = await app.inject({ method: "POST", url: "/fulfilments", payload: { orders } });
	expect(res.json()).toEqual([
		{ trackingId: "trk_post_a", lane: "post" },
		{ trackingId: "trk_courier_b", lane: "courier" },
		{ trackingId: "trk_hold_c", lane: "hold" },
	]);
	// Three runs of the two-step body: three "tier" steps and three bookings.
	expect(spans.filter((s) => s.key === "tier")).toHaveLength(3);
	expect(spans.filter((s) => s.id === "shipping/book@1")).toHaveLength(3);
});

test("place-order: a workflow is used as a node, then two steps run in parallel", async () => {
	const mail: string[] = [];
	const spans: Span[] = [];
	const mailer: Ports["mailer"] = { send: async (to, subject, body) => void mail.push(`${to} | ${subject} | ${body}`) };
	const { app } = await start(fakePorts({ mailer }), (span) => spans.push(span));
	const res = await app.inject({ method: "POST", url: "/orders/place", payload: desk });
	expect(res.json()).toEqual({ orderId: "ord_1", receiptId: "rc_1", trackingId: "trk_courier_ord_1", emailed: true });
	expect(mail).toEqual(["c_1 | Receipt for order ord_1 | Paid 180.00. Receipt rc_1."]);
	const parent = Object.fromEntries(spans.map((s) => [s.key ?? s.id, s.parent]));
	expect(parent.checkout).toBe("workflows/place-order@1");
	expect(parent.courier).toBe("workflows/fulfil@1");
});

test("catalog-sync: a loop that runs until it is done lives inside a node, and the workflow sees one step", async () => {
	const pagesOf = (served: number): Ports["http"] => ({
		request: async ({ url }) => {
			const page = Number(new URL(url).searchParams.get("page"));
			const next = page < served ? `https://supplier.example/catalog?page=${page + 1}` : null;
			return { status: 200, data: { items: [`sku-${page}a`, `sku-${page}b`], next } };
		},
	});
	const saved: unknown[] = [];
	const kv: Ports["kv"] = { set: async (_key, value) => void saved.push(value), list: async () => saved };

	const spans: Span[] = [];
	const done = await start(fakePorts({ http: pagesOf(3), kv }), (span) => spans.push(span));
	const res = await done.app.inject({ method: "POST", url: "/catalog/sync" });
	expect(res.json()).toEqual({
		items: ["sku-1a", "sku-1b", "sku-2a", "sku-2b", "sku-3a", "sku-3b"],
		pages: 3,
		complete: true,
	});
	expect(saved).toHaveLength(1);
	// Three requests happened, and the trace shows one step for them.
	expect(spans.filter((s) => s.id === "http/fetch-pages@1")).toHaveLength(1);

	// The node's own limit stops a feed that never ends, and the workflow skips the save.
	saved.length = 0;
	const endless = await start(fakePorts({ http: pagesOf(1000), kv }));
	const capped = await endless.app.inject({ method: "POST", url: "/catalog/sync" });
	expect(capped.json()).toMatchObject({ pages: 50, complete: false });
	expect(saved).toHaveLength(0);
});

// ---- the check has to be able to fail ----------------------------------------------------

async function problemsOf(workflow: Workflow) {
	const units = await discoverNodes(join(root, "nodes"));
	const shapes = (id: string) => {
		if (id.startsWith("workflows/")) return {}; // Another workflow: known, with no shape to compare against.
		const unit = units.get(id);
		return unit ? { input: contract(unit).input as object, output: contract(unit).output as object } : undefined;
	};
	return checkWorkflow(workflow, shapes).problems;
}
/** Finds a step by name anywhere in the workflow, branches included. */
function find(entries: Entry[], name: string): Step | undefined {
	for (const entry of entries) {
		if ("conditions" in entry) {
			for (const branch of entry.conditions) {
				const found = find("else" in branch ? branch.else : branch.steps, name);
				if (found) return found;
			}
		} else if ("parallel" in entry) {
			const found = find(entry.parallel, name);
			if (found) return found;
		} else if ("fail" in entry) {
			// A refusal is not a step: it has no name to look for.
		} else if (entry.name === name) return entry;
		else if (entry.onError) {
			const found = find(entry.onError, name);
			if (found) return found;
		}
	}
	return undefined;
}
const inputsOf = (workflow: Workflow, step: string) =>
	(find(workflow.steps, step) as Step).inputs as Record<string, unknown>;

/** A copy of checkout with one thing changed. */
const checkout = (edit: (workflow: Workflow, inputs: (step: string) => Record<string, unknown>) => void) => {
	const copy = definition("checkout");
	edit(copy, (step) => inputsOf(copy, step));
	return copy;
};
const stepOf = (workflow: Workflow, index: number) => workflow.steps[index] as unknown as Record<string, unknown>;

test("check: a misspelled field is found when the workflow loads, not when a request hits it", async () => {
	const problems = await problemsOf(
		checkout((_w, inputs) => Object.assign(inputs("price"), { items: "${order.itemz}" })),
	);
	expect(problems).toEqual([
		'step "price", input "items": "order" has no field "itemz". It has: orderId, customerId, items.',
	]);
});

test("check: a missing input, an unknown input and an unknown node", async () => {
	const problems = await problemsOf(
		checkout((w, inputs) => {
			Object.assign(inputs("order"), { item: "${request.body.items}" });
			// biome-ignore lint/performance/noDelete: the point is a key that is absent, as it would be in the JSON file.
			delete inputs("order").items;
			stepOf(w, 1).node = "orders/price-ordr@1";
		}),
	);
	expect(problems).toEqual([
		'step "order": "orders/validate-order@1" has no input "item". It takes: customerId, items.',
		'step "order": "orders/validate-order@1" needs input "items".',
		'step "price": uses "orders/price-ordr@1", which is not a known node.',
	]);
});

test("check: a string wired into a number, and a literal outside an enum", async () => {
	const wired = await problemsOf(
		checkout((_w, inputs) => Object.assign(inputs("charge"), { amountCents: "${order.orderId}" })),
	);
	expect(wired).toEqual(['step "charge", input "amountCents": expects integer, but ${order.orderId} is string.']);

	const fulfil = definition("fulfil");
	Object.assign(inputsOf(fulfil, "post"), { lane: "courrier" });
	expect(await problemsOf(fulfil)).toEqual([
		'step "post", input "lane": "courrier" is not one of ["courier","post","hold"].',
	]);
});

test("check: the original's `ctx.` and `js/` forms get a pointer to the new way", async () => {
	const problems = await problemsOf(
		checkout((_w, inputs) => {
			Object.assign(inputs("order"), { customerId: "${ctx.request.body.customerId}" });
			Object.assign(inputs("price"), { items: "js/ctx.response.data.items" });
		}),
	);
	expect(problems).toEqual([
		'step "order", input "customerId": ${ctx.request.body.customerId} uses "ctx", which is gone. Write ${request.body.x} or ${step-name.field}.',
		'step "price", input "items": "js/" expressions are gone. Reference a value with ${...}, or move the logic into a node.',
	]);
});

test("check: code inside ${ } is refused, in an input and in a condition", async () => {
	const problems = await problemsOf(
		checkout((w, inputs) => {
			Object.assign(inputs("charge"), { token: "${request.body.token || 'none'}" });
			stepOf(w, 2).if = "${price.totalCents > 10000 && order.items.length}";
		}),
	);
	expect(problems).toEqual([
		'step "flag": "${price.totalCents > 10000 && order.items.length}" is not a path. Only a path such as ${order.items} can go inside ${ }.',
		'step "charge", input "token": "${request.body.token || \'none\'}" is not a path. Only a path such as ${order.items} can go inside ${ }.',
	]);
});

test("check: a condition has to compare things that can be compared", async () => {
	const notBoolean = await problemsOf(checkout((w) => Object.assign(stepOf(w, 2), { if: "${price.totalCents}" })));
	expect(notBoolean).toEqual([
		'step "flag": "${price.totalCents}" is integer, not true or false. Compare it with a value.',
	]);
	const notNumber = await problemsOf(checkout((w) => Object.assign(stepOf(w, 2), { if: "${order.orderId} > 5" })));
	expect(notNumber).toEqual(['step "flag": "${order.orderId} > 5" compares string with integer.']);
});

test("check: a step that may be skipped cannot be read later, and names stay unique", async () => {
	const skipped = await problemsOf(checkout((w) => Object.assign(w.result as object, { flagged: "${flag.flagged}" })));
	expect(skipped).toEqual(['result.flagged: ${flag.flagged} reads step "flag", which may not have run at this point.']);

	const names = await problemsOf(
		checkout((w) => {
			w.steps.push({ name: "price", node: "orders/price-order@1", inputs: { items: "${order.items}" } });
		}),
	);
	expect(names).toEqual(['Two steps are named "price".']);
});

test("check: a step with `each` produces a list, so reading a field off it is refused", async () => {
	const quote = definition("quote");
	Object.assign(quote.result as object, { firstSku: "${lines.sku}" });
	expect(await problemsOf(quote)).toEqual(['result.firstSku: "lines" is a list, so it has no field "sku".']);
});

test("check: `${prev}` is refused where there is no single previous step", async () => {
	const placeOrder = definition("place-order");
	placeOrder.steps.push({ name: "audit", node: "storage/kv-set@1", inputs: { key: "last-order", value: "${prev}" } });
	expect(await problemsOf(placeOrder)).toEqual([
		'step "audit", input "value": ${prev} has no single previous step here. Use the step\'s name.',
	]);
});

test("check: loading refuses a broken workflow and lists every problem", async () => {
	const bad = checkout((w, inputs) => {
		w.trigger = undefined;
		// biome-ignore lint/performance/noDelete: the point is a key that is absent, as it would be in the JSON file.
		delete inputs("price").items;
	});
	const err = await load([{ id: "workflows/broken@1", workflow: bad }]).catch((e) => e);
	expect(err.message).toBe(
		'Workflow check failed:\n- workflows/broken@1: step "price": "orders/price-order@1" needs input "items".',
	);
});
