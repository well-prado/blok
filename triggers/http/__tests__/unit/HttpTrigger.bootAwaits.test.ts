/**
 * #873 — the last two unbounded awaits on `listen()`'s boot path.
 *
 * Same family as #752 (PR #865, the bind) and #868 (PR #872, `listNodes()`):
 * **an await on the boot path must be able to FAIL, not only hang.**
 *
 *  1. a `Workflows.ts` entry that is a never-settling promise (a lazy
 *     `import()` deadlocked on a circular dep / top-level await), and
 *  2. a sibling trigger's pre-catch-all hook whose promise never settles —
 *     the old `await result.catch(...)` caught rejection but not TIME.
 *
 * Both used to stall boot forever with no error, no exit, and nothing naming
 * the culprit. Each test below feeds in a promise that NEVER settles: without
 * the bound, `listen()` never resolves and the test dies on the real
 * wall-clock budget on the `it(...)` instead of asserting anything.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutable so each test controls the manual registrations without a second
// module mock (the boot path reads this object at call time).
const { workflowsMock } = vi.hoisted(() => ({ workflowsMock: {} as Record<string, unknown> }));
vi.mock("../../src/Workflows", () => ({ default: workflowsMock }));
vi.mock("../../src/AppRoutes", () => {
	const { Hono } = require("hono");
	return { default: new Hono() };
});
const mockServer = { close: vi.fn(), on: vi.fn() };
vi.mock("@hono/node-server", () => ({
	serve: vi.fn((_opts: unknown, cb?: () => void) => {
		cb?.();
		return mockServer;
	}),
}));
vi.mock("@hono/node-server/serve-static", () => ({ serveStatic: () => vi.fn() }));
vi.mock("@hono/node-server/utils/response", () => ({ RESPONSE_ALREADY_SENT: new Response(null) }));

import { WorkflowRegistry } from "@blokjs/runner";
import HttpTrigger from "../../src/runner/HttpTrigger.js";

/**
 * Fake timers make the 10s bound instant, but boot does REAL (unfaked) fs work
 * on the way to the awaits under test — so pump the clock until `listen()`
 * settles instead of advancing once: each step also yields to the real event
 * loop, letting boot get far enough to schedule the timer in the first place.
 * WITHOUT the bound nothing ever settles, the loop runs out, and the `await`
 * below hangs until the `it(...)` budget kills the test — which is the point.
 */
async function runBoot(trigger: HttpTrigger): Promise<void> {
	let settled = false;
	const pending = trigger.listen().finally(() => {
		settled = true;
	});
	for (let i = 0; i < 200 && !settled; i++) await vi.advanceTimersByTimeAsync(500);
	await pending;
}

describe("#873 · listen() bounds the foreign promises it awaits at boot", () => {
	let errors: string[];

	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		for (const k of Object.keys(workflowsMock)) delete workflowsMock[k];
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_METRICS_DISABLED = "1";
		errors = [];
		vi.spyOn(console, "error").mockImplementation((line: unknown) => {
			errors.push(String(line));
		});
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		// biome-ignore lint/performance/noDelete: restore literal absence, not the string "undefined"
		delete process.env.BLOK_METRICS_DISABLED;
	});

	it("a never-settling Workflows.ts entry fails the registration naming the key instead of hanging boot", async () => {
		workflowsMock.wedged = new Promise(() => {});

		await runBoot(new HttpTrigger());

		const line = errors.find((e) => e.includes("TS workflow registration failed"));
		expect(line).toBeDefined();
		expect(line).toContain("wedged"); // names the offending key
		expect(line).toContain("did not settle");
	}, 5_000); // real ms — a hang can't pass this; a bounded boot finishes in a fraction of it

	it("a never-settling pre-catch-all hook is reported naming the hook instead of hanging boot", async () => {
		const trigger = new HttpTrigger();
		const wedgedHook = () => new Promise<void>(() => {});
		trigger.addPreCatchAllHook(wedgedHook);

		await runBoot(trigger);

		const line = errors.find((e) => e.includes("pre-catch-all hook"));
		expect(line).toBeDefined();
		expect(line).toContain("wedgedHook"); // names the hook
		expect(line).toContain("did not settle");
	}, 5_000);
});
