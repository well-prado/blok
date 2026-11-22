// Five things the agent runs found missing, each a common practice for a backend:
// a status for a create, errors that say when they happen, a way to refuse without a node,
// taking back what was done when a later step fails, and a check that looks inside lists.
import { expect, test } from "bun:test";
import Fastify from "fastify";
import { z } from "zod";
import { mount } from "../src/fastify.ts";
import {
	type Span,
	type Unit,
	type Workflow,
	blok,
	checkWorkflow,
	checkWorkflows,
	contract,
	httpBinding,
	loadWorkflows,
} from "../src/index.ts";

interface Ports {
	log: string[];
	/** The names of the steps that should fail. */
	broken: Set<string>;
}
const { node, runtime } = blok<Ports>();

/** A node that records that it ran, and fails when the test says so. */
const act = (id: string, errors: Record<string, string> = {}) =>
	node({
		id,
		input: z.object({ ref: z.string().optional() }),
		output: z.object({ ref: z.string() }),
		errors,
		run({ ref }, { ports, fail }) {
			const name = id.split("/")[1].split("@")[0];
			ports.log.push(name);
			if (ports.broken.has(name))
				throw Object.keys(errors).length > 0
					? fail(Object.keys(errors)[0], `${name} failed`)
					: new Error(`${name} crashed`);
			return { ref: ref ?? name };
		},
	});
const takeStock = act("shop/take-stock@1");
const returnStock = act("shop/return-stock@1");
const chargeCard = act("shop/charge-card@1", { card_declined: "The provider refused the card." });
const refundCard = act("shop/refund-card@1");
const storeOrder = act("shop/store-order@1");
const sendMail = act("shop/send-mail@1");
const all = [takeStock, returnStock, chargeCard, refundCard, storeOrder, sendMail];
const nodes = () => new Map<string, Unit>(all.map((unit) => [unit.id, unit]));
const shapes = (id: string) => {
	const unit = nodes().get(id);
	const described = unit && contract(unit);
	return (
		described && { input: described.input as object, output: described.output as object, errors: described.errors }
	);
};

function start(workflow: Workflow, broken: string[] = []) {
	const units = nodes();
	const [unit] = loadWorkflows([{ id: "workflows/checkout@1", workflow }], units);
	const log: string[] = [];
	const errors: string[] = [];
	const spans: Span[] = [];
	const { call } = runtime({
		ports: { log, broken: new Set(broken) },
		onSpan: (span) => spans.push(span),
		log: { info() {}, error: (message) => errors.push(message) },
	});
	return { unit, call, log, errors, spans };
}

// ---- taking back what was done ---------------------------------------------------------

const checkout: Workflow = {
	name: "Checkout",
	trigger: { http: { method: "POST", path: "/orders", status: 201, errors: { card_declined: 402 } } },
	steps: [
		{
			name: "stock",
			node: "shop/take-stock@1",
			undo: [{ name: "giveBack", node: "shop/return-stock@1", inputs: { ref: "${stock.ref}" } }],
		},
		{
			name: "charge",
			node: "shop/charge-card@1",
			undo: [{ name: "refund", node: "shop/refund-card@1", inputs: { ref: "${charge.ref}" } }],
		},
		{ name: "order", node: "shop/store-order@1" },
		{ name: "mail", node: "shop/send-mail@1" },
	],
	result: { order: "${order.ref}" },
};

test("undo: when a later step fails, the steps before it are taken back, the newest first", async () => {
	expect(checkWorkflow(checkout, shapes).problems).toEqual([]);

	// Nothing fails: nothing is undone.
	const fine = start(checkout);
	expect(await fine.call(fine.unit, {})).toEqual({ order: "store-order" });
	expect(fine.log).toEqual(["take-stock", "charge-card", "store-order", "send-mail"]);

	// Storing the order crashes after the card was charged: the charge is refunded, then the stock given back.
	const crashed = start(checkout, ["store-order"]);
	const err = await crashed.call(crashed.unit, {}).catch((e) => e);
	expect(err).toMatchObject({ code: "unexpected", node: "shop/store-order@1" });
	expect(crashed.log).toEqual(["take-stock", "charge-card", "store-order", "refund-card", "return-stock"]);
	// The undo steps are steps like any other: they are in the trace, under the workflow.
	expect(
		crashed.spans.filter((span) => span.key === "refund" || span.key === "giveBack").map((span) => span.ok),
	).toEqual([true, true]);

	// The step that fails is not undone itself: it never finished. Only what came before it is.
	const declined = start(checkout, ["charge-card"]);
	expect(await declined.call(declined.unit, {}).catch((e) => e)).toMatchObject({ code: "card_declined" });
	expect(declined.log).toEqual(["take-stock", "charge-card", "return-stock"]);
});

test("undo: one undo that fails does not stop the others, and the caller still gets the first error", async () => {
	const run = start(checkout, ["store-order", "refund-card"]);
	const err = await run.call(run.unit, {}).catch((e) => e);
	expect(err).toMatchObject({ code: "unexpected", message: "store-order crashed" });
	expect(run.log).toEqual(["take-stock", "charge-card", "store-order", "refund-card", "return-stock"]);
	expect(run.errors).toEqual(['workflows/checkout@1: a step could not be undone after "unexpected".']);
});

test("undo: a step that was skipped is not undone, and steps running side by side all finish first", async () => {
	const skipped = structuredClone(checkout);
	(skipped.steps[1] as { if?: string }).if = "${request.body.pay} == true";
	const free = start(skipped, ["store-order"]);
	await free.call(free.unit, { body: { pay: false } }).catch(() => {});
	expect(free.log).toEqual(["take-stock", "store-order", "return-stock"]);

	// The charge is still running when the order fails. It is left to finish, and then it is refunded.
	const slow = node({
		id: "shop/slow-charge@1",
		input: z.object({}),
		output: z.object({ ref: z.string() }),
		async run(_input, { ports }) {
			await new Promise((done) => setTimeout(done, 20));
			ports.log.push("slow-charge");
			return { ref: "paid" };
		},
	});
	const side: Workflow = {
		name: "Side by side",
		steps: [
			{
				parallel: [
					{
						name: "charge",
						node: "shop/slow-charge@1",
						undo: [{ name: "refund", node: "shop/refund-card@1", inputs: { ref: "${charge.ref}" } }],
					},
					{ name: "order", node: "shop/store-order@1" },
				],
			},
		],
		result: { ok: true },
	};
	const units = new Map([...nodes(), [slow.id, slow]]);
	const [unit] = loadWorkflows([{ id: "workflows/side@1", workflow: side }], units);
	const log: string[] = [];
	const { call } = runtime({ ports: { log, broken: new Set(["store-order"]) } });
	await call(unit, {}).catch(() => {});
	expect(log).toEqual(["store-order", "slow-charge", "refund-card"]);
});

test("undo: the check reads the undo steps too, and their failures need no status", () => {
	const wrong = structuredClone(checkout);
	(wrong.steps[0] as { undo: Array<{ inputs: Record<string, string> }> }).undo[0].inputs.ref = "${stock.reff}";
	expect(checkWorkflow(wrong, shapes).problems).toEqual([
		'step "giveBack", input "ref": "stock" has no field "reff". It has: ref.',
	]);
	// A later step is not visible to an earlier step's undo.
	const early = structuredClone(checkout);
	(early.steps[0] as { undo: Array<{ inputs: Record<string, string> }> }).undo[0].inputs.ref = "${order.ref}";
	expect(checkWorkflow(early, shapes).problems).toEqual([
		'step "giveBack", input "ref": ${order.ref} reads step "order", which may not have run at this point.',
	]);
	// An undo step that can fail with a code of its own does not need a status: its failure is logged, not answered.
	const risky = structuredClone(checkout);
	(risky.steps[0] as { undo: Array<{ node: string }> }).undo[0].node = "shop/charge-card@1";
	(risky.trigger as { http: { errors: Record<string, number> } }).http.errors = {};
	expect(checkWorkflow(risky, shapes).problems).toEqual([
		'step "charge" can fail with "card_declined", and the trigger gives that no status, so a caller would get a 500. Give "card_declined" a status in the trigger\'s errors.',
	]);
});

// ---- refusing without a node -----------------------------------------------------------

const ship: Workflow = {
	name: "Ship",
	trigger: { http: { method: "POST", path: "/ship", errors: { order_not_paid: 409, too_many: 422 } } },
	steps: [
		{
			fail: "order_not_paid",
			if: "${request.body.status} != 'paid'",
			message: "An order that is ${request.body.status} cannot ship.",
		},
		{
			conditions: [
				{ if: "${request.body.parcels} > 5", steps: [{ fail: "too_many" }] },
				{ else: [{ name: "mail", node: "shop/send-mail@1" }] },
			],
		},
	],
	result: { shipped: true },
};

test("fail: a workflow refuses a request itself, with a code, a message and a status", async () => {
	expect(checkWorkflow(ship, shapes).problems).toEqual([]);
	const run = start(ship);
	expect(await run.call(run.unit, { body: { status: "paid", parcels: 1 } })).toEqual({ shipped: true });
	expect(await run.call(run.unit, { body: { status: "cancelled", parcels: 1 } }).catch((e) => e)).toMatchObject({
		code: "order_not_paid",
		message: "An order that is cancelled cannot ship.",
		node: "workflows/checkout@1",
	});
	// Inside a branch it needs no condition of its own, and without a message it still says something.
	expect(await run.call(run.unit, { body: { status: "paid", parcels: 9 } }).catch((e) => e)).toMatchObject({
		code: "too_many",
		message: "Refused: too_many.",
	});
	// Nothing ran before the refusal.
	expect(run.log).toEqual(["send-mail"]);

	// It reaches a caller with the status the trigger gives it.
	const app = Fastify();
	const binding = httpBinding(ship, run.unit);
	if (!binding) throw new Error("ship has an HTTP trigger");
	mount(app, binding, run.call);
	const refused = await app.inject({ method: "POST", url: "/ship", payload: { status: "shipped", parcels: 1 } });
	expect([refused.statusCode, refused.json().error]).toEqual([409, "order_not_paid"]);
});

test("fail: the check treats its code like any other error, and reads its condition and message", () => {
	const unmapped = structuredClone(ship);
	(unmapped.trigger as { http: { errors: Record<string, number> } }).http.errors = { too_many: 422 };
	expect(checkWorkflow(unmapped, shapes).problems).toEqual([
		'a "fail" entry can fail with "order_not_paid", and the trigger gives that no status, so a caller would get a 500. Give "order_not_paid" a status in the trigger\'s errors.',
	]);
	const bad = structuredClone(ship);
	bad.steps[0] = { fail: "Order Not Paid", if: "${mail.ref} == 'x'", message: "See ${nothing.here}." };
	expect(checkWorkflow(bad, shapes).problems).toEqual([
		'"Order Not Paid" cannot be an error code. Use lower case and underscores, such as cart_is_empty.',
		'fail "Order Not Paid": ${mail.ref} reads step "mail", which may not have run at this point.',
		'fail "Order Not Paid", message: ${nothing.here} reads "nothing", which does not exist.',
		'a "fail" entry can fail with "Order Not Paid", and the trigger gives that no status, so a caller would get a 500. Give "Order Not Paid" a status in the trigger\'s errors.',
	]);
	// A workflow used as a step passes its refusals on to the workflow that uses it.
	const outer: Workflow = {
		name: "Outer",
		trigger: { http: { method: "POST", path: "/outer", errors: { too_many: 422 } } },
		steps: [{ name: "inner", node: "workflows/ship@1", inputs: { status: "paid", parcels: 1 } }],
	};
	expect(
		checkWorkflows(
			[
				{ id: "workflows/outer@1", workflow: outer },
				{ id: "workflows/ship@1", workflow: ship },
			],
			nodes(),
		).problems,
	).toEqual([
		'workflows/outer@1: step "inner" can fail with "order_not_paid", and the trigger gives that no status, so a caller would get a 500. Give "order_not_paid" a status in the trigger\'s errors.',
	]);
});

// ---- a status for a create -------------------------------------------------------------

test("status: a workflow that creates something answers 201, and the check refuses a status that is not a success", async () => {
	const run = start(checkout);
	const app = Fastify();
	const binding = httpBinding(checkout, run.unit);
	if (!binding) throw new Error("checkout has an HTTP trigger");
	mount(app, binding, run.call);
	const created = await app.inject({ method: "POST", url: "/orders", payload: {} });
	expect([created.statusCode, created.json()]).toEqual([201, { order: "store-order" }]);

	// An error keeps its own status.
	const declined = start(checkout, ["charge-card"]);
	const other = Fastify();
	mount(other, httpBinding(checkout, declined.unit) as NonNullable<ReturnType<typeof httpBinding>>, declined.call);
	expect((await other.inject({ method: "POST", url: "/orders", payload: {} })).statusCode).toBe(402);

	const wrong = structuredClone(checkout);
	(wrong.trigger as { http: { status: number } }).http.status = 404;
	expect(checkWorkflow(wrong, shapes).problems).toEqual([
		"The trigger's status is 404. A successful answer has a status from 200 to 299.",
	]);
});

// ---- errors that say when they happen --------------------------------------------------

test("errors: a node says when each error happens, and that reaches its contract", async () => {
	expect(contract(chargeCard)).toMatchObject({
		errors: ["card_declined"],
		errorMeanings: { card_declined: "The provider refused the card." },
	});
	// A plain list of codes still works, and has nothing to say about them.
	const plain = node({
		id: "shop/plain@1",
		input: z.object({}),
		output: z.object({}),
		errors: ["sold_out"],
		run: (_input, { fail }) => {
			throw fail("sold_out", "None left.");
		},
	});
	expect(contract(plain)).toMatchObject({ errors: ["sold_out"], errorMeanings: {} });
	const { call } = runtime({ ports: { log: [], broken: new Set() } });
	expect((await call(plain, {}).catch((e) => e)).code).toBe("sold_out");
	// Written either way, a code that was not declared is refused.
	const run = start(checkout, ["charge-card"]);
	expect(await run.call(run.unit, {}).catch((e) => e)).toMatchObject({ code: "card_declined" });
});

// ---- looking inside lists --------------------------------------------------------------

const line = (quantity: z.ZodType) => z.object({ sku: z.string(), quantity });
const reader = (id: string, lines: z.ZodType) =>
	node({ id, input: z.object({}), output: z.object({ lines }), run: () => ({ lines: [] }) as never });
const taker = node({
	id: "stock/take@1",
	input: z.object({ items: z.array(line(z.number().int())) }),
	output: z.object({ taken: z.number().int() }),
	run: ({ items }) => ({ taken: items.length }),
});

test("the check compares what a step gives with what the next one takes, all the way into a list's items", () => {
	const problemsWith = (lines: z.ZodType) => {
		const cart = reader("cart/read@1", lines);
		const units = new Map<string, Unit>([
			[cart.id, cart],
			[taker.id, taker],
		]);
		const workflow: Workflow = {
			name: "Take",
			steps: [
				{ name: "cart", node: "cart/read@1" },
				{ name: "taken", node: "stock/take@1", inputs: { items: "${cart.lines}" } },
			],
		};
		return checkWorkflows([{ id: "workflows/take@1", workflow }], units).problems;
	};
	const at = 'workflows/take@1: step "taken", input "items": ${cart.lines} does not fit. In it,';

	// The same shape, with more in it than is needed: fine.
	expect(problemsWith(z.array(line(z.number().int()).extend({ name: z.string() })))).toEqual([]);
	// A field of the wrong kind, inside the items.
	expect(problemsWith(z.array(line(z.string())))).toEqual([`${at} [].quantity is string, and integer is needed.`]);
	// A fraction where a whole number is needed.
	expect(problemsWith(z.array(line(z.number())))).toEqual([`${at} [].quantity is number, and integer is needed.`]);
	// A field that is not there at all.
	expect(problemsWith(z.array(z.object({ sku: z.string() })))).toEqual([`${at} [] has no "quantity".`]);
	// A field that may be left out, or may be null, where a value is needed.
	expect(problemsWith(z.array(line(z.number().int().optional())))).toEqual([`${at} [].quantity may be missing.`]);
	expect(problemsWith(z.array(line(z.number().int().nullable())))).toEqual([
		`${at} [].quantity may be null, and integer is needed.`,
	]);
	// The whole list may be null.
	expect(problemsWith(z.array(line(z.number().int())).nullable())).toEqual([
		'workflows/take@1: step "taken", input "items": ${cart.lines} does not fit. In it, it may be null, and array is needed.',
	]);
});
