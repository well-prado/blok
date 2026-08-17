/**
 * Per-node orchestration overhead harness (#874 follow-up).
 *
 * A parallel forEach over N items with a 3-step trivial body: no I/O, no
 * runtime adapter — every millisecond here is runner orchestration. Reports
 * per-iteration wall time across deciles so a regression in the tail (GC from
 * per-iteration clones) is visible, not just the mean.
 *
 * Run: bun run benchmarks/foreach-hotpath.ts [items] [runs]
 * Logs off by default (the production shape); BLOK_LOG_LEVEL=info to measure
 * with the per-node log lines actually emitting.
 */
import { http, defineNode, forEach, step, workflow } from "@blokjs/core";
import { runWorkflow } from "@blokjs/core/testing";
import { z } from "zod";

const ITEMS = Number(process.argv[2] ?? 1200);
const RUNS = Number(process.argv[3] ?? 5);

const seed = defineNode({
	name: "seed",
	input: z.object({ n: z.number() }),
	output: z.object({ items: z.array(z.object({ sku: z.string(), qty: z.number() })) }),
	async execute(_ctx, input) {
		return { items: Array.from({ length: input.n }, (_, i) => ({ sku: `sku-${i}`, qty: i })) };
	},
});

// Per-item spans: body1 stamps the start, body3 the end, keyed by the unique
// sku. Gives ITEMS samples per run (real deciles) on top of the run totals.
const spanStart = new Map<string, number>();
const visits = new Map<string, number>();
let spans: number[] = [];

const trivial = defineNode({
	name: "trivial",
	input: z.object({ sku: z.string(), qty: z.number() }),
	output: z.object({ sku: z.string(), qty: z.number() }),
	async execute(_ctx, input) {
		const n = (visits.get(input.sku) ?? 0) + 1;
		visits.set(input.sku, n);
		if (n === 1) spanStart.set(input.sku, performance.now());
		else if (n === 3) spans.push(performance.now() - (spanStart.get(input.sku) as number));
		return { sku: input.sku, qty: input.qty + 1 };
	},
});

// A few filler steps so ctx.config carries more than the forEach body — the
// whole-config clones scale with workflow size, the slice clones do not.
const filler = defineNode({
	name: "filler",
	input: z.object({ a: z.string() }),
	output: z.object({ a: z.string() }),
	async execute(_ctx, input) {
		return input;
	},
});

export const bench = workflow(
	"foreach-hotpath",
	{ version: "1.0.0", trigger: http.post("/bench") },
	(_req: unknown) => {
		const seeded = step("seed", seed, { n: ITEMS });
		for (let i = 0; i < 8; i++) {
			step(`filler${i}`, filler, { a: `pad-${i}-${"x".repeat(64)}` });
		}
		forEach(
			seeded.items,
			(item) => {
				const a = step("body1", trivial, { sku: item.sku, qty: item.qty });
				const b = step("body2", trivial, { sku: a.sku, qty: a.qty });
				step("body3", trivial, { sku: b.sku, qty: b.qty });
			},
			{ id: "loopResults", as: "row", mode: "parallel", concurrency: 10 },
		);
	},
);

function decile(sorted: number[], d: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * d) / 10))];
}

async function once(): Promise<{ total: number; per: number }> {
	visits.clear();
	spanStart.clear();
	spans = [];
	const t0 = performance.now();
	const run = await runWorkflow(bench, {}, { timeout: 600_000 });
	const total = performance.now() - t0;
	if (!run.ok) throw new Error(`workflow failed: ${JSON.stringify(run.error)}`);
	const results = run.state("loopResults") as unknown[];
	if (results?.length !== ITEMS) throw new Error(`expected ${ITEMS} results, got ${results?.length}`);
	return { total, per: total / ITEMS };
}

const totals: number[] = [];
const allSpans: number[] = [];
await once(); // warmup (JIT + node registry)
for (let r = 0; r < RUNS; r++) {
	const { total, per } = await once();
	totals.push(total);
	allSpans.push(...spans);
	console.log(`run ${r + 1}: ${total.toFixed(0)}ms total, ${(per * 1000).toFixed(0)}µs/iteration`);
}
const sorted = allSpans.sort((a, b) => a - b);
const meanTotal = totals.reduce((s, v) => s + v, 0) / totals.length;
const us = (v: number) => (v * 1000).toFixed(0);
console.log(
	`\nitems=${ITEMS} runs=${RUNS} log=${process.env.BLOK_LOG_LEVEL ?? "off (warn)"}\n` +
		`total: mean ${meanTotal.toFixed(0)}ms  best ${Math.min(...totals).toFixed(0)}ms  ` +
		`→ ${((meanTotal / ITEMS) * 1000).toFixed(0)}µs per iteration (3 nodes)\n` +
		`per-iteration body span µs (n=${sorted.length}): ` +
		`p10 ${us(decile(sorted, 1))}  p50 ${us(decile(sorted, 5))}  p90 ${us(decile(sorted, 9))}  ` +
		`p99 ${us(sorted[Math.floor(sorted.length * 0.99)])}  max ${us(sorted[sorted.length - 1])}`,
);
// `runWorkflow`'s timeout race leaves its setTimeout armed, so the event loop
// stays alive long after the last result. Results are printed — just leave.
process.exit(0);
