// The nodes the shared tests run on. Every kernel writes these same nodes in its own language,
// and conformance/README.md says what each one does.
import { z } from "zod";
import { blok, todo } from "../../src/index.ts";

export interface Ports {
	/** What the nodes wrote down, in the order they wrote it. */
	journal: string[];
	/** How many times each name was counted. */
	counter: Record<string, number>;
}
export const { node, runtime } = blok<Ports>();
export const freshPorts = (): Ports => ({ journal: [], counter: {} });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Counts a call, fails while the count is no more than `failures`, and can refuse instead. */
const flaky = (
	{ name, failures, refuse }: { name: string; failures: number; refuse: boolean },
	ports: Ports,
	fail: (code: string, message: string) => Error,
) => {
	const calls = (ports.counter[name] ?? 0) + 1;
	ports.counter[name] = calls;
	if (refuse) throw fail("refused", "It was refused.");
	if (calls <= failures) throw new Error(`flaky failure ${calls}`);
	return { calls };
};
const flakyInput = z.object({ name: z.string(), failures: z.number().int(), refuse: z.boolean().default(false) });

export const nodes = [
	node({
		id: "test/add@1",
		description: "Adds two numbers.",
		input: z.object({ a: z.number(), b: z.number() }),
		output: z.object({ sum: z.number() }),
		run: ({ a, b }) => ({ sum: a + b }),
	}),
	node({
		id: "test/greet@1",
		description: "Greets someone by name.",
		input: z.object({ name: z.string(), greeting: z.string().default("Hello") }),
		output: z.object({ text: z.string() }),
		run: ({ name, greeting }) => ({ text: `${greeting}, ${name}!` }),
	}),
	node({
		id: "test/echo@1",
		description: "Answers with the value it was given, whatever it is.",
		input: z.object({ value: z.unknown() }),
		output: z.object({ value: z.unknown() }),
		run: ({ value }) => ({ value }),
	}),
	node({
		id: "test/typed@1",
		description: "Answers with what it was given: a whole number, a number, true or false, and a list of text.",
		input: z.object({
			count: z.number().int(),
			ratio: z.number().default(1),
			flag: z.boolean().default(false),
			tags: z.array(z.string()).default([]),
		}),
		output: z.object({ count: z.number().int(), ratio: z.number(), flag: z.boolean(), tags: z.array(z.string()) }),
		run: (input) => input,
	}),
	node({
		id: "test/items@1",
		description: "Answers with a fixed list of two items.",
		input: z.object({}),
		output: z.object({
			items: z.array(z.object({ sku: z.string(), qty: z.number().int() })),
			total: z.number().int(),
		}),
		run: () => ({
			items: [
				{ sku: "book", qty: 2 },
				{ sku: "pen", qty: 5 },
			],
			total: 7,
		}),
	}),
	node({
		id: "test/fail@1",
		description: "Always fails, with the code and the message it was given.",
		input: z.object({ code: z.string(), message: z.string().default("It failed.") }),
		output: z.object({}),
		errors: { out_of_stock: "Nothing is left to sell.", card_declined: "The bank refused the card." },
		run: ({ code, message }, { fail }) => {
			throw fail(code, message);
		},
	}),
	node({
		id: "test/maybe@1",
		description: "Writes its note down, then refuses unless `ok` is true.",
		input: z.object({ ok: z.boolean(), note: z.string().default("") }),
		output: z.object({ note: z.string() }),
		errors: { refused: "`ok` was false." },
		effects: ["journal:write"],
		run: ({ ok, note }, { ports, fail }) => {
			ports.journal.push(note);
			if (!ok) throw fail("refused", `It was refused: ${note}`);
			return { note };
		},
	}),
	node({
		id: "test/record@1",
		description: "Writes its note down and says where in the journal it landed, counting from 1.",
		input: z.object({ note: z.string() }),
		output: z.object({ note: z.string(), position: z.number().int() }),
		effects: ["journal:write"],
		run: ({ note }, { ports }) => ({ note, position: ports.journal.push(note) }),
	}),
	node({
		id: "test/flaky@1",
		description:
			"Fails the first `failures` times it is called under a name. Safe to run twice, and tried up to 3 times.",
		input: flakyInput,
		output: z.object({ calls: z.number().int() }),
		errors: { refused: "`refuse` was true." },
		effects: ["counter:write"],
		idempotent: true,
		retries: 2,
		run: (input, { ports, fail }) => flaky(input, ports, fail),
	}),
	node({
		id: "test/once@1",
		description: "The same as test/flaky, and not safe to run twice, so it is never tried again.",
		input: flakyInput,
		output: z.object({ calls: z.number().int() }),
		errors: { refused: "`refuse` was true." },
		effects: ["counter:write"],
		retries: 2,
		run: (input, { ports, fail }) => flaky(input, ports, fail),
	}),
	node({
		id: "test/slow@1",
		description: "Waits `ms` milliseconds. It is given 40, and is tried twice.",
		input: z.object({ ms: z.number().int() }),
		output: z.object({ slept: z.number().int() }),
		idempotent: true,
		retries: 1,
		timeoutMs: 40,
		run: async ({ ms }) => {
			await sleep(ms);
			return { slept: ms };
		},
	}),
	node({
		id: "test/wrong@1",
		description: "Promises a number and answers with text.",
		input: z.object({}),
		output: z.object({ n: z.number() }),
		// @ts-expect-error The point of this node is an answer its contract does not allow.
		run: () => ({ n: "not a number" }),
	}),
	node({
		id: "test/crash@1",
		description: "Breaks in a way nobody planned for.",
		input: z.object({}),
		output: z.object({}),
		run: () => {
			throw new Error("the database is down");
		},
	}),
	node({
		id: "test/empty@1",
		description: "A contract with no logic yet.",
		input: z.object({ name: z.string() }),
		output: z.object({ text: z.string() }),
		run: todo,
	}),
];
