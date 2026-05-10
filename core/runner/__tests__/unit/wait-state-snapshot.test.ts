/**
 * v0.6 prerequisite for wait-inside-primitives Phase 2 — state snapshot
 * + rehydrate across `WaitDispatchRequest` dispatch.
 *
 * Covers:
 *   - RunnerSteps writes `state_snapshot` to the run record before
 *     throwing WaitDispatchRequest
 *   - TriggerBase.run rehydrates `ctx.state` from the snapshot on
 *     dispatchDeferred re-entry (covering the cross-process recovery
 *     path where ctx is rebuilt fresh)
 *   - `BLOK_STATE_SNAPSHOT_DISABLED=1` opt-out short-circuits the
 *     snapshot write
 *   - `BLOK_STATE_SNAPSHOT_MAX_BYTES` cap surfaces a warning when
 *     exceeded and skips the snapshot
 *   - `ctx.state` and `ctx.vars` stay aliased after rehydrate (the
 *     `vars: state` reference in createContext keeps pointing at the
 *     same object — proves we mutate state in place rather than
 *     reassigning)
 */

import type { Context } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Runner from "../../src/Runner";
import RunnerNode from "../../src/RunnerNode";
import TriggerBase from "../../src/TriggerBase";
import { DeferredDispatchSignal } from "../../src/scheduling/DeferredDispatchSignal";
import { DeferredRunScheduler } from "../../src/scheduling/DeferredRunScheduler";
import { RunTracker } from "../../src/tracing/RunTracker";

// Minimal step that mutates ctx.state directly so we have something
// to snapshot. Mirrors how `@blokjs/ctx-publish` works in production —
// writes a known key/value to ctx.state during run().
class StateWriterNode extends RunnerNode {
	constructor(
		name: string,
		private payload: Record<string, unknown>,
	) {
		super();
		this.name = name;
		this.node = name;
		this.type = "module";
		this.active = true;
	}

	async run(ctx: Context) {
		const state = (ctx.state ?? {}) as Record<string, unknown>;
		Object.assign(state, this.payload);
		return { success: true, data: this.payload, error: null };
	}
}

// Reads ctx.state at the moment of execution and writes a snapshot
// of the visible keys onto state under `name`. Used to verify what the
// post-wait step sees after rehydrate.
class StateReaderNode extends RunnerNode {
	constructor(name: string) {
		super();
		this.name = name;
		this.node = name;
		this.type = "module";
		this.active = true;
	}

	async run(ctx: Context) {
		const state = (ctx.state ?? {}) as Record<string, unknown>;
		// Capture a snapshot of state contents excluding self (since the
		// runner will write our own output back).
		const observed: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(state)) {
			if (k === this.name) continue;
			observed[k] = v;
		}
		state.__readerObserved = observed;
		return { success: true, data: observed, error: null };
	}
}

// Wait placeholder — RunnerSteps intercepts before invoking it.
class WaitPlaceholderNode extends RunnerNode {
	public waitForMs?: number;
	constructor(name: string, waitForMs?: number) {
		super();
		this.name = name;
		this.node = "@blokjs/wait";
		this.type = "wait";
		this.active = true;
		this.waitForMs = waitForMs;
	}
	async run() {
		return { success: true, data: { __waited__: true }, error: null };
	}
}

class TestTrigger extends TriggerBase {
	public writer = new StateWriterNode("pre-wait", { tenantId: "acme", cart: [{ sku: "abc", qty: 2 }] });
	public waitStep = new WaitPlaceholderNode("wait-1", 5_000);
	public reader = new StateReaderNode("post-wait");

	async listen(): Promise<number> {
		return 0;
	}

	override getRunner(): Runner {
		return new Runner([this.writer, this.waitStep, this.reader]);
	}

	configure(): void {
		this.configuration.name = "wait-state-snap-wf";
		this.configuration.trigger = { http: { method: "POST", path: "/wait-snap" } } as never;
	}

	async exposeDispatchDeferred(ctx: Context, runId: string): Promise<void> {
		await this.dispatchDeferred(ctx, runId, undefined);
	}
}

describe("v0.6 prereq · ctx.state snapshot before WaitDispatchRequest", () => {
	beforeEach(() => {
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		RunTracker.resetInstance();
		DeferredRunScheduler.resetInstance();
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("writes ctx.state to workflow_runs.state_snapshot before throwing WaitDispatchRequest", async () => {
		const t = new TestTrigger();
		t.configure();
		const ctx = t.createContext(undefined, "/wait-snap", "snap-run-1");

		await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);

		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		const persisted = RunTracker.getInstance().getStore().getRun(runId);

		expect(persisted?.status).toBe("delayed");
		expect(persisted?.stateSnapshot).toBeDefined();

		const snap = JSON.parse(persisted?.stateSnapshot as string) as Record<string, unknown>;
		// StateWriterNode mutates ctx.state directly with the payload keys.
		// (Default v2 step-output persistence is gated by `Blok.run` —
		// raw RunnerNode subclasses bypass it. The snapshot captures
		// whatever ctx.state actually holds, which is exactly what
		// production workflows have at the wait throw site.)
		expect(snap.tenantId).toBe("acme");
		expect(snap.cart).toEqual([{ sku: "abc", qty: 2 }]);
	});

	it("rehydrates ctx.state on dispatchDeferred re-entry — cross-process simulation with FRESH ctx", async () => {
		// Phase A — first pass with original ctx
		const t = new TestTrigger();
		t.configure();
		const ctx1 = t.createContext(undefined, "/wait-snap", "snap-run-2");
		await expect(t.run(ctx1)).rejects.toBeInstanceOf(DeferredDispatchSignal);

		const runId = (ctx1 as unknown as Record<string, unknown>)._traceRunId as string;
		const tracker = RunTracker.getInstance();
		expect(tracker.getStore().getRun(runId)?.stateSnapshot).toBeDefined();

		// Phase B — simulate cross-process recovery: build a FRESH ctx,
		// stash _traceRunId, set _blokDispatchReentry, then call run.
		// `restoreDispatch` does the same thing in production with the
		// persisted scheduled_dispatches payload.
		const ctx2 = t.createContext(undefined, "/wait-snap", "snap-run-2-resumed");
		(ctx2 as unknown as Record<string, unknown>)._traceRunId = runId;
		(ctx2 as unknown as Record<string, unknown>)._blokDispatchReentry = true;

		// Sanity: fresh ctx starts with empty state.
		expect(Object.keys(ctx2.state as Record<string, unknown>)).toHaveLength(0);

		await t.run(ctx2);

		// Post-wait reader should have observed the rehydrated state.
		const observed = (ctx2.state as Record<string, unknown>).__readerObserved as Record<string, unknown>;
		expect(observed).toBeDefined();
		expect(observed.tenantId).toBe("acme");
		expect(observed.cart).toEqual([{ sku: "abc", qty: 2 }]);

		// Run finished cleanly.
		expect(tracker.getStore().getRun(runId)?.status).toBe("completed");
	});

	it("preserves the ctx.state ↔ ctx.vars alias after rehydrate (mutates state in place, doesn't reassign)", async () => {
		// Critical invariant: createContext sets `vars: state` so both
		// names reference the SAME object. If rehydrate did
		// `ctx.state = JSON.parse(snapshot)` it would silently fork the
		// two views — `ctx.state.foo` would see the rehydrated value but
		// `ctx.vars.foo` would still be the empty original. Authors
		// using either name continue to work post-rehydrate.
		const t = new TestTrigger();
		t.configure();

		const ctx1 = t.createContext(undefined, "/wait-snap", "snap-run-3");
		await expect(t.run(ctx1)).rejects.toBeInstanceOf(DeferredDispatchSignal);
		const runId = (ctx1 as unknown as Record<string, unknown>)._traceRunId as string;

		const ctx2 = t.createContext(undefined, "/wait-snap", "snap-run-3-resumed");
		(ctx2 as unknown as Record<string, unknown>)._traceRunId = runId;
		(ctx2 as unknown as Record<string, unknown>)._blokDispatchReentry = true;

		// Capture the same-reference invariant BEFORE rehydrate fires.
		expect(ctx2.state).toBe(ctx2.vars);

		await t.run(ctx2);

		// Same invariant AFTER rehydrate — must still be the same object.
		expect(ctx2.state).toBe(ctx2.vars);
		// And both views see the rehydrated content.
		expect((ctx2.vars as Record<string, unknown>).tenantId).toBe("acme");
	});

	it("BLOK_STATE_SNAPSHOT_DISABLED=1 opts the snapshot out — column stays NULL", async () => {
		vi.stubEnv("BLOK_STATE_SNAPSHOT_DISABLED", "1");

		const t = new TestTrigger();
		t.configure();
		const ctx = t.createContext(undefined, "/wait-snap", "snap-run-4");
		await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);

		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		const persisted = RunTracker.getInstance().getStore().getRun(runId);
		expect(persisted?.stateSnapshot).toBeUndefined();
		// Wait still defers — kill-switch only disables the snapshot,
		// not the wait machinery.
		expect(persisted?.status).toBe("delayed");
	});

	it("BLOK_STATE_SNAPSHOT_MAX_BYTES skips the snapshot when exceeded + logs warning", async () => {
		vi.stubEnv("BLOK_STATE_SNAPSHOT_MAX_BYTES", "10"); // unrealistically tiny

		const warnings: string[] = [];
		const t = new TestTrigger();
		t.configure();
		const ctx = t.createContext(undefined, "/wait-snap", "snap-run-5");
		// Hook the logger to capture warning level entries.
		const origLogLevel = ctx.logger.logLevel.bind(ctx.logger);
		ctx.logger.logLevel = (level: string, message: string) => {
			if (level === "warn") warnings.push(message);
			origLogLevel(level, message);
		};

		await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);

		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		const persisted = RunTracker.getInstance().getStore().getRun(runId);
		expect(persisted?.stateSnapshot).toBeUndefined();
		expect(warnings.some((w) => w.includes("snapshot exceeds 10 bytes"))).toBe(true);
	});

	it("warns + skips when ctx.state contains a circular reference (JSON.stringify throws)", async () => {
		const warnings: string[] = [];
		const t = new TestTrigger();
		t.configure();
		// Replace the writer with one that produces a circular reference.
		// Cast through unknown — the anonymous class does NOT extend
		// StateWriterNode (which would force a `payload` field), it just
		// satisfies the RunnerNode shape the runner consumes.
		t.writer = new (class extends RunnerNode {
			constructor() {
				super();
				this.name = "circular-writer";
				this.node = "circular-writer";
				this.type = "module";
				this.active = true;
			}
			async run(ctx: Context) {
				const state = ctx.state as Record<string, unknown>;
				const cycle: { self?: unknown } = {};
				cycle.self = cycle;
				state.cycle = cycle;
				return { success: true, data: { circular: true }, error: null };
			}
		})() as unknown as StateWriterNode;
		// Re-build the runner through getRunner() — we override here so
		// the helper picks up the new writer instance.
		(t as unknown as { getRunner: () => Runner }).getRunner = () => new Runner([t.writer, t.waitStep, t.reader]);

		const ctx = t.createContext(undefined, "/wait-snap", "snap-run-6");
		const origLogLevel = ctx.logger.logLevel.bind(ctx.logger);
		ctx.logger.logLevel = (level: string, message: string) => {
			if (level === "warn") warnings.push(message);
			origLogLevel(level, message);
		};

		await expect(t.run(ctx)).rejects.toBeInstanceOf(DeferredDispatchSignal);

		const runId = (ctx as unknown as Record<string, unknown>)._traceRunId as string;
		const persisted = RunTracker.getInstance().getStore().getRun(runId);
		expect(persisted?.stateSnapshot).toBeUndefined();
		expect(warnings.some((w) => w.includes("failed to serialize"))).toBe(true);
		// Wait still defers.
		expect(persisted?.status).toBe("delayed");
	});
});
