// What the boundary costs: a direct function, one node through `call`, and a whole workflow.
//   bun run build && bun run bench      (the workflow is loaded from the built JSON)
import { type Unit, loadProject } from "@blokjs/kernel";
import { z } from "zod";
import { fakePorts } from "./app.ts";
import { node, runtime } from "./blok.ts";

const double = node({
	id: "bench/double@1",
	input: z.object({ n: z.number() }),
	output: z.object({ n: z.number() }),
	run: ({ n }) => ({ n: n * 2 }),
});
const direct = async ({ n }: { n: number }) => ({ n: n * 2 });

async function time(label: string, iterations: number, fn: (i: number) => Promise<unknown>) {
	for (let i = 0; i < 20_000; i++) await fn(i); // warm up
	const runs: number[] = [];
	for (let r = 0; r < 5; r++) {
		const t0 = performance.now();
		for (let i = 0; i < iterations; i++) await fn(i);
		runs.push(((performance.now() - t0) * 1000) / iterations);
	}
	runs.sort((a, b) => a - b);
	console.log(
		`${label.padEnd(44)} median ${runs[2].toFixed(3)} µs  (min ${runs[0].toFixed(3)}, max ${runs[4].toFixed(3)})`,
	);
	return runs[2];
}

let spans = 0;
const { call } = runtime({ ports: fakePorts(), onSpan: () => void spans++ });
const project = await loadProject({ dir: import.meta.dirname });
const checkout = project.units.get("workflows/checkout@1") as Unit;
const order = { body: { customerId: "c_1", items: [{ sku: "sku-book", qty: 2 }], token: "tok_ok" } };

const a = await time("direct async function", 200_000, (i) => direct({ n: i }));
const b = await time("call(node): validate in+out, span", 200_000, (i) => call(double, { n: i }));
const c = await time("call(checkout): workflow + 3 nodes", 50_000, () => call(checkout, order));
console.log(`\nboundary overhead per node call: ${(b - a).toFixed(3)} µs`);
console.log(`checkout per unit (4 units): ${(c / 4).toFixed(3)} µs`);
console.log(`spans recorded: ${spans}`);
