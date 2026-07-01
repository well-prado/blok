/**
 * CronTrigger — REAL wall-clock integration test (issue #599).
 *
 * Unlike `CronTrigger.test.ts` (pure shape/schema unit checks), this drives
 * the trigger against the REAL system clock: it registers a schedule that
 * fires every second (`* * * * * *` — the smallest interval the `cron` v4
 * parser accepts, since field 1 is seconds) and asserts the workflow actually
 * executes over a real ~3.5s / ~5.5s window. No fake timers, no mocked cron —
 * the installed `cron` package's `CronJob` owns the timers, and each fire goes
 * through the full dispatch path (`executeWorkflow` → `Configuration.init` →
 * `TriggerBase.run` → the fixture node's `execute`).
 *
 * The fixture nodes record an OBSERVABLE side effect (a module-level counter)
 * so the assertions prove the node body ACTUALLY RAN on each tick, not merely
 * that a job was scheduled. Every workflow path is namespaced with a random
 * suffix so a concurrent target on the same box can't collide.
 *
 * Proves:
 *   1. Real clock firing — an every-second schedule executes the workflow
 *      multiple times across a real ~3.5s window (count grows with time).
 *   2. Single-fire coordination (`overlap: false`) — while one occurrence is
 *      still in flight (a 2.5s node), subsequent ticks are SKIPPED, so a fired
 *      occurrence is never double-executed. Peak concurrency stays at 1 even
 *      though the timer fired several times during the slow run.
 */

import { workflow } from "@blokjs/helper";
import { NodeMap, defineNode } from "@blokjs/runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CronTrigger } from "./CronTrigger";

// Silence the operational handlers (crash-autoflip / janitor / graceful
// shutdown) that TriggerBase installs at listen(): they attach process-level
// listeners + timers that outlive the test otherwise. Saved + restored per test.
const OPS_ENVS = ["BLOK_JANITOR_DISABLED", "BLOK_CRASH_AUTOFLIP_DISABLED", "BLOK_GRACEFUL_SHUTDOWN_DISABLED"];
const savedEnv: Record<string, string | undefined> = {};

/**
 * Build a minimal concrete CronTrigger whose only workflow fires on `schedule`
 * and runs `node`. Overrides loadNodes/loadWorkflows to populate the registries
 * directly — the parent's default readers work too, but this keeps the fixture
 * self-contained and mirrors the tracing test's pattern.
 */
function makeTrigger(schedule: string, overlap: boolean, node: ReturnType<typeof defineNode>) {
	const path = `cron-int-${Math.random().toString(36).slice(2)}`;
	const wf = workflow({
		name: path,
		version: "1.0.0",
		trigger: { cron: { schedule, timezone: "UTC", overlap } },
		steps: [{ id: "tick", use: node.name, inputs: {} }],
	});

	class IntegrationCron extends CronTrigger {
		protected nodes = {} as never;
		protected workflows = {} as never;
		override loadNodes(): void {
			this.nodeMap.nodes = new NodeMap();
			this.nodeMap.nodes.addNode(node.name, node);
		}
		override loadWorkflows(): void {
			this.nodeMap.workflows = { [path]: wf } as never;
		}
	}

	return new IntegrationCron();
}

describe("CronTrigger — issue #599 real wall-clock firing", () => {
	beforeEach(() => {
		for (const k of OPS_ENVS) {
			savedEnv[k] = process.env[k];
			process.env[k] = "1";
		}
	});

	afterEach(() => {
		for (const k of OPS_ENVS) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
	});

	it("fires every second on the real clock and executes the workflow repeatedly", async () => {
		const fires: number[] = [];
		const tickNode = defineNode({
			name: `cron-int-tick-${Math.random().toString(36).slice(2)}`,
			description: "records each fire timestamp",
			input: z.object({}).passthrough(),
			output: z.object({ ok: z.boolean() }),
			async execute() {
				fires.push(Date.now());
				return { ok: true };
			},
		});

		const trigger = makeTrigger("* * * * * *", false, tickNode);
		await trigger.listen();

		// One job is scheduled and it carries the real every-second expression.
		const jobs = trigger.getJobs();
		expect(jobs).toHaveLength(1);
		expect(jobs[0].schedule).toBe("* * * * * *");
		expect(fires).toHaveLength(0); // nothing has fired yet — real time hasn't passed

		// Real ~3.5s window: an every-second cron should fire ≥2 times. The upper
		// bound guards against a runaway/looping bug (a real 1Hz clock can't
		// exceed ~4 fires in 3.5s).
		await new Promise((r) => setTimeout(r, 3500));
		const midCount = fires.length;
		expect(midCount).toBeGreaterThanOrEqual(2);
		expect(midCount).toBeLessThanOrEqual(5);

		await trigger.stop();

		// The count grew with real time and stops growing after stop() — proves
		// the fires came from the live clock, not a synchronous burst at boot.
		await new Promise((r) => setTimeout(r, 1500));
		expect(fires.length).toBe(midCount);
	}, 20_000);

	it("does not double-execute an in-flight occurrence when overlap is disabled", async () => {
		let starts = 0;
		let inFlight = 0;
		let concurrentPeak = 0;
		const slowNode = defineNode({
			name: `cron-int-slow-${Math.random().toString(36).slice(2)}`,
			description: "a 2.5s occurrence — longer than the 1s tick interval",
			input: z.object({}).passthrough(),
			output: z.object({ ok: z.boolean() }),
			async execute() {
				starts++;
				inFlight++;
				concurrentPeak = Math.max(concurrentPeak, inFlight);
				await new Promise((r) => setTimeout(r, 2500));
				inFlight--;
				return { ok: true };
			},
		});

		const trigger = makeTrigger("* * * * * *", false, slowNode);
		await trigger.listen();

		// ~5.5s window: the 1Hz clock fires ~5 times, but each occurrence takes
		// 2.5s. With overlap disabled, a tick that lands while the prior run is
		// still in flight is SKIPPED — so at most one occurrence runs at a time.
		await new Promise((r) => setTimeout(r, 5500));
		await trigger.stop();
		// let the last in-flight occurrence drain so inFlight can't false-trip
		await new Promise((r) => setTimeout(r, 2600));

		// Non-vacuous: the timer fired multiple times during the window (so the
		// overlap gate was genuinely exercised, not a single lonely fire)…
		expect(starts).toBeGreaterThanOrEqual(2);
		// …yet the occurrence was never double-executed — peak concurrency is 1.
		// Without the `running && !overlap` skip, an unguarded 1Hz cron over a
		// 5.5s window of 2.5s runs would stack ≥2 concurrently.
		expect(concurrentPeak).toBe(1);
	}, 20_000);
});
