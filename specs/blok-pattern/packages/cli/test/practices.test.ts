// The five practices, written the way an author writes them: in Pkl, and in JSON by hand.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { blokctl, cleanUp, project, write } from "./helpers.ts";

afterAll(cleanUp);
setDefaultTimeout(60_000);

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
const json = (dir: string, file: string) => JSON.parse(read(dir, file));

const charge = (meaning = "The provider refused the card.") => `import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "shop/charge@1",
	description: "Charges a payment token.",
	input: z.object({ token: z.string() }),
	output: z.object({ paymentId: z.string() }),
	errors: { card_declined: "${meaning}" },
	run({ token }, { fail }) {
		if (token === "tok_bad") throw fail("card_declined", "The card was declined.");
		return { paymentId: \`pay_\${token}\` };
	},
});
`;
const refund = `import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "shop/refund@1",
	input: z.object({ paymentId: z.string() }),
	output: z.object({ refunded: z.string() }),
	run: ({ paymentId }) => ({ refunded: paymentId }),
});
`;
const store = `import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "shop/store@1",
	input: z.object({ paymentId: z.string(), note: z.string().optional() }),
	output: z.object({ orderId: z.string() }),
	run({ paymentId, note }) {
		if (note === "boom") throw new Error("The database is down.");
		return { orderId: \`ord_\${paymentId}\` };
	},
});
`;
const buy = (edit: (source: string) => string = (source) => source) =>
	edit(`amends "blok/Workflow.pkl"

import "blok/shop.pkl"

name = "Buy"
version = "1.0.0"

trigger {
  http = new {
    method = "POST"
    path = "/buy"
    status = 201
    errors {
      ["card_declined"] = 402
      ["nothing_to_buy"] = 422
    }
  }
}

local charge = new shop.Charge {
  name = "charge"
  inputs { token = "\${request.body.token}" }
  undo {
    new shop.Refund {
      name = "refund"
      inputs { paymentId = charge.outputs.paymentId }
    }
  }
}

local stored = new shop.Store {
  name = "stored"
  inputs {
    paymentId = charge.outputs.paymentId
    note = "\${request.body.note}"
  }
}

steps {
  new Fail {
    fail = "nothing_to_buy"
    \`if\` = "\${request.body.quantity} == 0"
    message = "There is nothing to buy."
  }
  charge
  stored
}

result {
  orderId = stored.outputs.orderId
}
`);

function shop(): string {
	const dir = project();
	write(dir, "nodes/shop/charge/v1/node.ts", charge());
	write(dir, "nodes/shop/refund/v1/node.ts", refund);
	write(dir, "nodes/shop/store/v1/node.ts", store);
	write(dir, "workflows/buy.pkl", buy());
	return dir;
}
const order = (body: Record<string, unknown>) => ["run", "buy", "--input", JSON.stringify({ body }), "--json"];

test("a status, a refusal and an undo are written in Pkl and come out in the built JSON", () => {
	const dir = shop();
	expect(blokctl(dir, ["build"])).toEqual({
		exit: 0,
		out: "Built 2 workflows into .blok/workflows.\nThe API is described in .blok/openapi.json.",
		err: "",
	});
	const built = json(dir, ".blok/workflows/buy.json");
	expect(built.trigger.http).toEqual({
		method: "POST",
		path: "/buy",
		status: 201,
		errors: { card_declined: 402, nothing_to_buy: 422 },
	});
	expect(built.steps).toEqual([
		{ fail: "nothing_to_buy", message: "There is nothing to buy.", if: "${request.body.quantity} == 0" },
		{
			name: "charge",
			node: "shop/charge@1",
			inputs: { token: "${request.body.token}" },
			undo: [{ name: "refund", node: "shop/refund@1", inputs: { paymentId: "${charge.paymentId}" } }],
		},
		{
			name: "stored",
			node: "shop/store@1",
			inputs: { paymentId: "${charge.paymentId}", note: "${request.body.note}" },
		},
	]);

	// It goes well.
	expect(JSON.parse(blokctl(dir, order({ token: "tok_1", quantity: 1 })).out)).toMatchObject({
		ok: true,
		output: { orderId: "ord_pay_tok_1" },
	});
	// The workflow refuses by itself, before anything ran.
	const refused = JSON.parse(blokctl(dir, order({ token: "tok_1", quantity: 0 })).out);
	expect(refused.error).toEqual({
		code: "nothing_to_buy",
		message: "There is nothing to buy.",
		node: "workflows/buy@1",
	});
	expect(refused.spans.map((span: { id: string }) => span.id)).toEqual(["workflows/buy@1"]);
	// Storing the order fails after the card was charged: the trace shows the charge being refunded.
	const crashed = JSON.parse(blokctl(dir, order({ token: "tok_1", quantity: 1, note: "boom" })).out);
	expect(crashed.error).toMatchObject({ code: "unexpected", node: "shop/store@1" });
	expect(
		crashed.spans.map((span: { key?: string; id: string; ok: boolean }) => `${span.key ?? span.id}:${span.ok}`),
	).toEqual(["charge:true", "stored:false", "refund:true", "workflows/buy@1:false"]);
});

test("Pkl refuses a status that is not a success, a malformed error code, and an undo with a wrong field", () => {
	const dir = shop();
	write(
		dir,
		"workflows/buy.pkl",
		buy((source) => source.replace("status = 201", "status = 404")),
	);
	expect(blokctl(dir, ["check"]).err).toMatch(/Type constraint `isBetween\(200, 299\)` violated[\s\S]*buy\.pkl/);
	write(
		dir,
		"workflows/buy.pkl",
		buy((source) => source.replace('fail = "nothing_to_buy"', 'fail = "Nothing To Buy"')),
	);
	expect(blokctl(dir, ["check"]).err).toMatch(/Type constraint[\s\S]*violated[\s\S]*Nothing To Buy/);
	write(
		dir,
		"workflows/buy.pkl",
		buy((source) => source.replace("paymentId = charge.outputs.paymentId }", "paymentId = charge.outputs.payment }")),
	);
	expect(blokctl(dir, ["check"]).err).toContain("Cannot find property `payment`");
	// The check still asks for a status for the refusal.
	write(
		dir,
		"workflows/buy.pkl",
		buy((source) => source.replace('      ["nothing_to_buy"] = 422\n', "")),
	);
	expect(blokctl(dir, ["check"]).err).toBe(
		'1 problem:\n- workflows/buy@1: a "fail" entry can fail with "nothing_to_buy", and the trigger gives that no status, so a caller would get a 500. Give "nothing_to_buy" a status in the trigger\'s errors.',
	);
});

test("the same things written as JSON by hand pass the same check", () => {
	const dir = shop();
	blokctl(dir, ["build"]);
	const built = json(dir, ".blok/workflows/buy.json");
	rmSync(join(dir, "workflows/buy.pkl"));
	write(dir, "workflows/buy.json", JSON.stringify(built));
	expect(blokctl(dir, ["check"]).out).toBe("4 nodes and 2 workflows line up.");

	built.steps[0].because = "no reason";
	built.steps[1].undo[0].nodes = "typo";
	built.trigger.http.status = 500;
	write(dir, "workflows/buy.json", JSON.stringify(built));
	expect(blokctl(dir, ["check"]).err).toBe(
		[
			"3 problems:",
			"- buy.json: trigger.http.status must be <= 299.",
			'- buy.json: steps.0 has an unknown key "because".',
			'- buy.json: steps.1.undo.0 has an unknown key "nodes".',
		].join("\n"),
	);
});

test("an error says when it happens, and that reaches the catalog, the brief and contract.json", () => {
	const dir = shop();
	expect(blokctl(dir, ["show", "shop/charge"]).out).toContain(
		"  errors:\n    card_declined  (The provider refused the card.)",
	);
	expect(blokctl(dir, ["prompt", "build", "shop/charge"]).out).toContain(
		'How it may fail: throw one of these with `throw fail("<code>", "<message>")`. No other code is allowed.\n\n- card_declined: The provider refused the card.',
	);
	blokctl(dir, ["lock"]);
	expect(json(dir, "nodes/shop/charge/v1/contract.json")).toMatchObject({
		errors: ["card_declined"],
		errorMeanings: { card_declined: "The provider refused the card." },
	});
	// Saying it better is not a change of contract. A different code is.
	write(dir, "nodes/shop/charge/v1/node.ts", charge("The bank said no."));
	expect(blokctl(dir, ["check"]).exit).toBe(0);
	write(
		dir,
		"nodes/shop/charge/v1/node.ts",
		charge().replace("card_declined:", "declined:").replace('fail("card_declined"', 'fail("declined"'),
	);
	expect(blokctl(dir, ["check"]).err).toContain("shop/charge@1: its errors are not what contract.json promises.");
	// A node made by `new node` starts with the described form.
	blokctl(dir, ["new", "node", "shop/ship"]);
	expect(read(dir, "nodes/shop/ship/v1/node.ts")).toContain("errors: {},");
});

test("the check looks inside a list: an item with the wrong kind of field is found before anything runs", () => {
	const dir = shop();
	write(
		dir,
		"nodes/shop/cart/v1/node.ts",
		`import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "shop/cart@1",
	input: z.object({}),
	output: z.object({ lines: z.array(z.object({ sku: z.string(), quantity: z.string() })) }),
	run: () => ({ lines: [] }),
});
`,
	);
	write(
		dir,
		"nodes/shop/take/v1/node.ts",
		`import { z } from "zod";
import { node } from "#blok";

export default node({
	id: "shop/take@1",
	input: z.object({ items: z.array(z.object({ sku: z.string(), quantity: z.number().int() })) }),
	output: z.object({ taken: z.number().int() }),
	run: ({ items }) => ({ taken: items.length }),
});
`,
	);
	write(
		dir,
		"workflows/take.pkl",
		`amends "blok/Workflow.pkl"

import "blok/shop.pkl"

name = "Take"
version = "1.0.0"
trigger { http = new { method = "POST"; path = "/take" } }

local cart = new shop.Cart { name = "cart" }

steps {
  cart
  new shop.Take { name = "taken"; inputs { items = cart.outputs.lines } }
}
`,
	);
	// Pkl sees a list going into a list and is content. The check reads the contracts and is not.
	expect(blokctl(dir, ["check"]).err).toBe(
		'1 problem:\n- workflows/take@1: step "taken", input "items": ${cart.lines} does not fit. In it, [].quantity is string, and integer is needed.',
	);
});
