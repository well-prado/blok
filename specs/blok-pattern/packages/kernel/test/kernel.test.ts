import { expect, test } from "bun:test";
import { z } from "zod";
import { type Schema, type Span, blok, contract, isTodo, todo } from "../src/index.ts";

interface Ports {
	crm: { flag(id: string): Promise<void> };
}
const { node, runtime } = blok<Ports>();
const noPorts: Ports = { crm: { flag: async () => {} } };

const double = node({
	id: "demo/double@1",
	description: "Doubles a number.",
	input: z.object({ n: z.number().int(), label: z.string().default("x") }),
	output: z.object({ n: z.number().int() }),
	run: ({ n }) => ({ n: n * 2 }),
});

test("a node runs through one boundary: input and output are validated and a span is recorded", async () => {
	const spans: Span[] = [];
	const { call } = runtime({ ports: noPorts, onSpan: (span) => spans.push(span) });
	expect(await call(double, { n: 21 })).toEqual({ n: 42 });
	expect(spans).toMatchObject([{ id: "demo/double@1", kind: "node", ok: true, attempts: 1 }]);

	// @ts-expect-error n must be a number: the compiler catches this, and so does the boundary
	const bad = await call(double, { n: "21" }).catch((err) => err);
	expect(bad.code).toBe("invalid_input");
	expect(spans.at(-1)).toMatchObject({ ok: false, error: "invalid_input", attempts: 0 });

	const liar = node({
		id: "demo/liar@1",
		input: z.object({}),
		output: z.object({ n: z.number() }),
		// @ts-expect-error the output is checked by the compiler, and again at the boundary
		run: () => ({ n: "not a number" }),
	});
	expect((await call(liar, {}).catch((err) => err)).code).toBe("invalid_output");
});

test("an idempotent node is retried, a non-idempotent one is not", async () => {
	let calls = 0;
	const flaky = (idempotent: boolean) =>
		node({
			id: `demo/flaky-${idempotent ? "safe" : "unsafe"}@1`,
			input: z.object({ id: z.string() }),
			output: z.object({ flagged: z.boolean() }),
			idempotent,
			retries: 2,
			async run({ id }, { ports }) {
				await ports.crm.flag(id);
				return { flagged: true };
			},
		});
	const ports: Ports = {
		crm: {
			flag: async () => {
				if (++calls < 3) throw new Error("crm down");
			},
		},
	};
	const spans: Span[] = [];
	const { call } = runtime({ ports, onSpan: (span) => spans.push(span) });
	expect(await call(flaky(true), { id: "c_1" })).toEqual({ flagged: true });
	expect(spans[0].attempts).toBe(3);

	calls = 0;
	const err = await call(flaky(false), { id: "c_1" }).catch((e) => e);
	expect(err.code).toBe("unexpected");
	expect(calls).toBe(1);
});

test("a node can only fail with a code its contract declares, and a business failure is never retried", async () => {
	let runs = 0;
	const picky = node({
		id: "demo/picky@1",
		input: z.object({ code: z.string() }),
		output: z.object({}),
		errors: ["known"],
		idempotent: true,
		retries: 3,
		run: ({ code }, { fail }) => {
			runs++;
			throw fail(code, "refused");
		},
	});
	const { call } = runtime({ ports: noPorts });
	const known = await call(picky, { code: "known" }).catch((e) => e);
	expect(known).toMatchObject({ code: "known", node: "demo/picky@1" });
	expect(runs).toBe(1);

	const surprise = await call(picky, { code: "surprise" }).catch((e) => e);
	expect(surprise.code).toBe("unexpected");
	expect(surprise.message).toContain("does not declare");
});

test("a node that runs past its timeout is stopped", async () => {
	const slow = node({
		id: "demo/slow@1",
		input: z.object({}),
		output: z.object({}),
		timeoutMs: 20,
		run: () => new Promise<Record<string, never>>((done) => setTimeout(() => done({}), 500)),
	});
	const started = performance.now();
	const err = await runtime({ ports: noPorts })
		.call(slow, {})
		.catch((e) => e);
	expect(err.code).toBe("timeout");
	expect(performance.now() - started).toBeLessThan(300);
});

test("the compiler keeps other units out of a node, and a bad id is refused", () => {
	const empty = { input: z.object({}), output: z.object({}) };
	// @ts-expect-error a node cannot call other units
	node({ id: "demo/bad-node@1", ...empty, run: (_input, { call }) => ({}) });
	expect(() => node({ id: "NotAnId", ...empty, run: () => ({}) })).toThrow("Bad unit id");
});

test("`todo` is a node with a contract and no logic yet: it can be described, and calling it says so", async () => {
	const later = node({
		id: "demo/later@1",
		input: z.object({ id: z.string() }),
		output: z.object({ done: z.boolean() }),
		run: todo,
	});
	expect(isTodo(later)).toBe(true);
	expect(isTodo(double)).toBe(false);
	expect(contract(later)).toMatchObject({ id: "demo/later@1", implemented: false });
	const err = await runtime({ ports: noPorts })
		.call(later, { id: "x" })
		.catch((e) => e);
	expect(err).toMatchObject({ code: "not_implemented", message: "demo/later@1 is not implemented yet." });
});

test("a contract is JSON Schema, read from the schema library itself", () => {
	const described = contract(double);
	expect(described).toMatchObject({ id: "demo/double@1", kind: "node", description: "Doubles a number.", errors: [] });
	// What a caller may pass: a field with a default is optional.
	expect(described.input).toMatchObject({ type: "object", required: ["n"] });
	expect(described.output).toMatchObject({ type: "object", required: ["n"], additionalProperties: false });

	// A schema library that cannot describe itself is named, with what to use instead.
	const bare: Schema<unknown> = { "~standard": { version: 1, vendor: "bare", validate: (value) => ({ value }) } };
	const opaque = node({ id: "demo/opaque@1", input: bare, output: bare, run: (input) => input });
	expect(() => contract(opaque)).toThrow(
		"demo/opaque@1: its input schema cannot be read as JSON Schema. Use a schema library that implements Standard JSON Schema",
	);

	// A type with no JSON Schema form is reported with the node it is in.
	const odd = node({
		id: "demo/odd@1",
		input: z.object({ when: z.union([z.string(), z.undefined()]) }),
		output: z.object({}),
		run: () => ({}),
	});
	expect(() => contract(odd)).toThrow(
		"demo/odd@1: its input schema cannot be written as JSON Schema. Undefined cannot be represented in JSON Schema.",
	);
});
