#!/usr/bin/env node

/**
 * Memory Leak Detection for Blok Runner
 *
 * Runs repeated workflow simulations and checks for memory growth.
 * If heap usage grows beyond threshold after GC, reports potential leak.
 */

const ITERATIONS = 5000;
const LEAK_THRESHOLD_MB = 50;
const SAMPLE_INTERVAL = 500;

function simulateWorkflowExecution() {
	const ctx = {
		id: `ctx-${Math.random().toString(36).slice(2)}`,
		request: {
			body: { data: Array.from({ length: 10 }, (_, i) => ({ id: i, value: `v-${i}` })) },
			headers: { "content-type": "application/json" },
			query: {},
			params: {},
		},
		response: { success: false, data: null, errors: null },
		vars: {},
	};

	// Simulate step execution
	for (let step = 0; step < 5; step++) {
		const stepResult = {
			success: true,
			data: { processed: true, step },
			errors: null,
			metrics: { duration_ms: Math.random() * 10, memory_bytes: 1024 },
		};
		ctx.vars[`step-${step}`] = stepResult;
	}

	ctx.response.success = true;
	ctx.response.data = ctx.vars;
	return ctx;
}

async function runMemoryCheck() {
	console.log("Memory Leak Detection");
	console.log("=".repeat(50));
	console.log(`Iterations: ${ITERATIONS}`);
	console.log(`Leak threshold: ${LEAK_THRESHOLD_MB}MB`);
	console.log();

	if (!global.gc) {
		console.error("Warning: Run with --expose-gc for accurate measurements");
		console.error("  node --expose-gc benchmarks/memory-check.mjs");
		console.log();
	}

	const samples = [];

	// Force initial GC
	if (global.gc) global.gc();
	const baseline = process.memoryUsage();
	console.log(`Baseline heap: ${(baseline.heapUsed / 1024 / 1024).toFixed(2)}MB`);

	for (let i = 0; i < ITERATIONS; i++) {
		simulateWorkflowExecution();

		if (i % SAMPLE_INTERVAL === 0) {
			if (global.gc) global.gc();
			const mem = process.memoryUsage();
			samples.push({
				iteration: i,
				heapUsedMB: mem.heapUsed / 1024 / 1024,
				heapTotalMB: mem.heapTotal / 1024 / 1024,
				rssMB: mem.rss / 1024 / 1024,
			});
		}
	}

	// Final measurement
	if (global.gc) global.gc();
	const final = process.memoryUsage();
	samples.push({
		iteration: ITERATIONS,
		heapUsedMB: final.heapUsed / 1024 / 1024,
		heapTotalMB: final.heapTotal / 1024 / 1024,
		rssMB: final.rss / 1024 / 1024,
	});

	// Report
	console.log("\nMemory Samples:");
	console.log("-".repeat(60));
	console.log("Iteration | Heap Used (MB) | Heap Total (MB) | RSS (MB)");
	console.log("-".repeat(60));
	for (const s of samples) {
		console.log(
			`${String(s.iteration).padStart(9)} | ${s.heapUsedMB.toFixed(2).padStart(14)} | ${s.heapTotalMB.toFixed(2).padStart(15)} | ${s.rssMB.toFixed(2).padStart(8)}`,
		);
	}

	const heapGrowth = final.heapUsed / 1024 / 1024 - baseline.heapUsed / 1024 / 1024;
	console.log(`\n${"=".repeat(50)}`);
	console.log(`Final heap: ${(final.heapUsed / 1024 / 1024).toFixed(2)}MB`);
	console.log(`Heap growth: ${heapGrowth.toFixed(2)}MB`);

	if (heapGrowth > LEAK_THRESHOLD_MB) {
		console.error("\nPOTENTIAL MEMORY LEAK DETECTED!");
		console.error(`Heap grew by ${heapGrowth.toFixed(2)}MB (threshold: ${LEAK_THRESHOLD_MB}MB)`);
		process.exit(1);
	} else {
		console.log(`\nNo memory leak detected (growth within ${LEAK_THRESHOLD_MB}MB threshold)`);
		process.exit(0);
	}
}

runMemoryCheck().catch((err) => {
	console.error("Memory check failed:", err);
	process.exit(1);
});
