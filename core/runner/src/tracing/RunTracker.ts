import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { v4 as uuid } from "uuid";
import type { ConcurrencyBackend } from "../concurrency/ConcurrencyBackend";
import { InMemoryRunStore } from "./InMemoryRunStore";
import type { RunStore } from "./RunStore";
import { createStore } from "./createStore";
import { sanitize } from "./sanitize";
import type {
	ConcurrencySlotResult,
	Dashboard,
	MetricsResult,
	NodeRun,
	RunErrorDetail,
	RunEvent,
	RunEventType,
	RunQuery,
	SavedFilter,
	StartNodeOptions,
	StartRunOptions,
	TraceLogEntry,
	WorkflowRun,
	WorkflowSample,
	WorkflowSummary,
} from "./types";

/**
 * Cap on the number of `NODE_ATTEMPT_FAILED` entries kept on a single
 * `NodeRun.attempts` array. Bounds store growth on extreme retry counts —
 * a runaway loop generating 1000 attempts can't bloat the run store. The
 * latest attempts are always preserved (older ones are dropped).
 */
const MAX_STORED_ATTEMPTS = 10;

/**
 * PR 1 follow-up · terminal status guard.
 *
 * Once a run reaches a terminal status, late-arriving completeRun/failRun
 * calls (e.g., from a runner that didn't see a parallel cancel) must NOT
 * overwrite it. Cancellation, expiry, throttling, crashes, and timeouts
 * all win over a stale "the steps finished" signal.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
	"completed",
	"failed",
	"cancelled",
	"throttled",
	"expired",
	"crashed",
	"timedOut",
]);

/**
 * Build a {@link RunErrorDetail} from any thrown error. When the source is
 * a typed `BlokError` (master plan §17), all 17+ structured fields are
 * preserved; otherwise the legacy `{message, stack}` shape falls through.
 *
 * Detection is duck-typed against the `category` field (BlokError carries
 * a `category` enum value like `"DEPENDENCY"`; vanilla `Error` never
 * does). This avoids a hard import dependency from the tracing layer
 * onto `@blokjs/shared`.
 */
function toRunErrorDetail(error: unknown): RunErrorDetail {
	if (error === null || error === undefined) {
		return { message: "unknown error" };
	}
	if (typeof error !== "object") {
		return { message: String(error) };
	}
	const e = error as Record<string, unknown>;
	const detail: RunErrorDetail = {
		message: typeof e.message === "string" ? e.message : "unknown error",
	};
	if (typeof e.stack === "string") detail.stack = e.stack;
	// Structured BlokError fields. We accept either runner-side
	// (`errorCode` getter on BlokError) or raw NodeErrorPayload (`code`)
	// shapes — failNode is called with the BlokError instance, but the
	// payload variant covers RunStore re-hydration paths.
	const code = e.errorCode ?? e.code;
	if (typeof code === "string" && code.length > 0) detail.code = code;
	if (typeof e.category === "string") detail.category = e.category;
	if (typeof e.severity === "string") detail.severity = e.severity;
	if (typeof e.httpStatus === "number") detail.httpStatus = e.httpStatus;
	if (typeof e.retryable === "boolean") detail.retryable = e.retryable;
	if (typeof e.retryAfterMs === "number") detail.retryAfterMs = e.retryAfterMs;
	if (typeof e.description === "string" && e.description.length > 0) detail.description = e.description;
	if (typeof e.remediation === "string" && e.remediation.length > 0) detail.remediation = e.remediation;
	if (typeof e.docUrl === "string" && e.docUrl.length > 0) detail.docUrl = e.docUrl;
	if (e.details !== undefined && e.details !== null) detail.details = e.details;
	if (e.contextSnapshot !== undefined && e.contextSnapshot !== null) detail.contextSnapshot = e.contextSnapshot;
	if (Array.isArray(e.causes) && e.causes.length > 0) {
		detail.causes = (e.causes as unknown[]).filter(
			(c): c is Record<string, unknown> => typeof c === "object" && c !== null,
		);
	}
	return detail;
}

/** Webhook registration for run event notifications. */
export interface Webhook {
	id: string;
	url: string;
	events: string[];
	secret?: string;
	createdAt: number;
	active: boolean;
	lastTriggeredAt?: number;
	lastStatus?: number;
	failCount: number;
}

export class RunTracker extends EventEmitter {
	private store: RunStore;
	private maxRuns: number;
	private enabled: boolean;
	private webhooks: Map<string, Webhook> = new Map();

	private static instance: RunTracker | null = null;

	constructor(maxRuns?: number, store?: RunStore) {
		super();
		this.setMaxListeners(100);
		this.maxRuns = maxRuns ?? Number.parseInt(process.env.BLOK_TRACE_MAX_RUNS || "1000", 10);
		this.enabled = process.env.BLOK_TRACE_ENABLED !== "false";
		this.store = store ?? new InMemoryRunStore();
	}

	static getInstance(): RunTracker {
		if (!RunTracker.instance) {
			const store = createStore();
			RunTracker.instance = new RunTracker(undefined, store);
		}
		return RunTracker.instance;
	}

	static resetInstance(): void {
		if (RunTracker.instance) {
			RunTracker.instance.store.close();
		}
		RunTracker.instance = null;
	}

	/** The underlying store for direct access if needed. */
	getStore(): RunStore {
		return this.store;
	}

	/** Fast path: skip all work when tracing is disabled */
	get active(): boolean {
		return this.enabled;
	}

	// === Workflow Lifecycle ===

	startRun(opts: StartRunOptions): WorkflowRun {
		// Phase 2.1 · environment scoping. Read `BLOK_ENV` (default
		// `production`) so every run carries the env it was triggered
		// against. Studio's EnvChip (`useEnvScope.current`) filters
		// list views by this field. Old runs without the field still
		// match `production` via the post-filter default.
		const environment = (process.env.BLOK_ENV || "production").trim() || "production";
		const run: WorkflowRun = {
			id: `run_${uuid().replace(/-/g, "").slice(0, 12)}`,
			workflowName: opts.workflowName,
			workflowPath: opts.workflowPath,
			triggerType: opts.triggerType,
			triggerSummary: opts.triggerSummary,
			status: "running",
			startedAt: Date.now(),
			nodeCount: opts.nodeCount,
			completedNodes: 0,
			tags: opts.tags,
			metadata: opts.metadata,
			environment,
			replayOf: opts.replayOf,
			parentRunId: opts.parentRunId,
			parentNodeRunId: opts.parentNodeRunId,
			scheduledAt: opts.scheduledAt,
			expiresAt: opts.expiresAt,
			debounceKey: opts.debounceKey,
			debounceMode: opts.debounceMode,
			pingCount: opts.pingCount,
		};

		this.store.saveRun(run);

		this.emitEvent(run.id, run.workflowName, "RUN_STARTED", undefined, undefined, {
			workflowName: run.workflowName,
			triggerType: run.triggerType,
			triggerSummary: run.triggerSummary,
			nodeCount: run.nodeCount,
		});

		this.store.evictOldRuns(this.maxRuns);
		return run;
	}

	completeRun(runId: string, data?: unknown): void {
		const run = this.store.getRun(runId);
		if (!run) return;

		// PR 1 follow-up · terminal-status guard. Don't overwrite a run that
		// has already reached a terminal status (cancelled / expired / etc.)
		// — a late completeRun from a runner that didn't see a parallel
		// cancel must not flip the status back. Defense in depth against the
		// REVIEW.md A2 class of bug.
		if (TERMINAL_STATUSES.has(run.status)) return;

		const finishedAt = Date.now();
		const durationMs = finishedAt - run.startedAt;

		this.store.updateRun(runId, {
			status: "completed",
			finishedAt,
			durationMs,
		});

		this.emitEvent(runId, run.workflowName, "RUN_COMPLETED", undefined, undefined, {
			durationMs,
			completedNodes: run.completedNodes,
			data,
		});
	}

	failRun(runId: string, error: Error | unknown): void {
		const run = this.store.getRun(runId);
		if (!run) return;

		// PR 1 follow-up · terminal-status guard. Same rationale as completeRun.
		if (TERMINAL_STATUSES.has(run.status)) return;

		const finishedAt = Date.now();
		const durationMs = finishedAt - run.startedAt;

		this.store.updateRun(runId, {
			status: "failed",
			finishedAt,
			durationMs,
			error: toRunErrorDetail(error),
		});

		this.emitEvent(runId, run.workflowName, "RUN_FAILED", undefined, undefined, {
			durationMs,
			error: toRunErrorDetail(error),
		});
	}

	/**
	 * Tier 2 #6 — mark a run as throttled because the concurrency gate
	 * denied it before any step executed. Distinct from `failRun` because
	 * no step ran; nothing produced an error. Studio surfaces a Throttled
	 * badge and SSE subscribers see a granular `RUN_THROTTLED` event.
	 */
	markRunThrottled(
		runId: string,
		info: { concurrencyKey: string; concurrencyLimit: number; currentInFlight: number },
	): void {
		const run = this.store.getRun(runId);
		if (!run) return;
		// Review fix-up · BUG-1. Don't overwrite a terminal status. A
		// concurrent operator-cancel or crash auto-flip might have flipped
		// the run between read and write; preserve the earlier terminal
		// outcome rather than re-marking as throttled.
		if (TERMINAL_STATUSES.has(run.status)) return;

		const finishedAt = Date.now();
		const durationMs = finishedAt - run.startedAt;

		this.store.updateRun(runId, {
			status: "throttled",
			finishedAt,
			durationMs,
		});

		this.emitEvent(runId, run.workflowName, "RUN_THROTTLED", undefined, undefined, {
			durationMs,
			concurrencyKey: info.concurrencyKey,
			concurrencyLimit: info.concurrencyLimit,
			currentInFlight: info.currentInFlight,
		});
	}

	/**
	 * Tier 2 #6 follow-up — mark a run as queued because the concurrency
	 * gate denied it AND the trigger is configured with `onLimit: "queue"`.
	 * The run will be re-attempted after `scheduledAt`; `scheduledAt` is
	 * persisted on the run record so Studio can render a "queued · retries
	 * at <time>" badge.
	 *
	 * Distinct from `markRunThrottled` because queued runs WILL eventually
	 * execute (or stay queued indefinitely until a slot frees), while
	 * throttled runs are terminal and `failRun` semantics are skipped.
	 *
	 * Caller is responsible for actually scheduling the retry via
	 * `DeferredRunScheduler`. This method only flips status + emits the
	 * `RUN_QUEUED` event. Re-marking with a later `scheduledAt` updates
	 * the field (used when re-defer happens after a timer-fired re-acquire
	 * also fails).
	 */
	markRunQueued(
		runId: string,
		info: {
			concurrencyKey: string;
			concurrencyLimit: number;
			currentInFlight: number;
			scheduledAt: number;
		},
	): void {
		const run = this.store.getRun(runId);
		if (!run) return;
		// Review fix-up · BUG-1. Don't overwrite a terminal status (e.g.,
		// `cancelled` from a concurrent operator-cancel during the
		// onLimit:queue re-defer race). The TTL-expired path is handled
		// separately in TriggerBase via QueueExpiredError.
		if (TERMINAL_STATUSES.has(run.status)) return;

		this.store.updateRun(runId, {
			status: "queued",
			scheduledAt: info.scheduledAt,
		});

		this.emitEvent(runId, run.workflowName, "RUN_QUEUED", undefined, undefined, {
			concurrencyKey: info.concurrencyKey,
			concurrencyLimit: info.concurrencyLimit,
			currentInFlight: info.currentInFlight,
			scheduledAt: info.scheduledAt,
		});
	}

	// === Scheduling lifecycle (Tier 2 #5 + #7) ===

	/**
	 * Tier 2 #5 — mark a run as `delayed`. Called immediately after
	 * `startRun` for runs that should be deferred. The run record carries
	 * `scheduledAt` (and optionally `expiresAt`) so Studio can render a
	 * "Delayed → fires at <time>" badge.
	 *
	 * Caller is responsible for actually scheduling the dispatch via
	 * `DeferredRunScheduler`. This method only flips status + emits the
	 * `RUN_DELAYED` event.
	 */
	markRunDelayed(runId: string, info: { scheduledAt: number; delayMs: number; expiresAt?: number }): void {
		const run = this.store.getRun(runId);
		if (!run) return;
		// Review fix-up · BUG-1. Don't overwrite a terminal status — e.g.,
		// a wait.for() re-entry race where the operator cancelled the run
		// while WaitDispatchRequest was being thrown.
		if (TERMINAL_STATUSES.has(run.status)) return;

		this.store.updateRun(runId, {
			status: "delayed",
			scheduledAt: info.scheduledAt,
			expiresAt: info.expiresAt,
		});

		this.emitEvent(runId, run.workflowName, "RUN_DELAYED", undefined, undefined, {
			scheduledAt: info.scheduledAt,
			delayMs: info.delayMs,
			expiresAt: info.expiresAt,
		});
	}

	/**
	 * Tier 2 #5 — mark a run as `expired` because its TTL was exceeded
	 * before dispatch. Distinct from `failed` (no step ran) and
	 * `cancelled` (operator action — TTL is automatic).
	 */
	markRunExpired(runId: string, info: { expiresAt: number; expiredAt: number }): void {
		const run = this.store.getRun(runId);
		if (!run) return;
		// Review fix-up · BUG-1. Don't overwrite a terminal status. A
		// run that was cancelled by an operator before the dispatch timer
		// fired should stay `cancelled`, not flip to `expired`.
		if (TERMINAL_STATUSES.has(run.status)) return;

		const finishedAt = info.expiredAt;
		const durationMs = finishedAt - run.startedAt;
		const lateBy = info.expiredAt - info.expiresAt;

		this.store.updateRun(runId, {
			status: "expired",
			finishedAt,
			durationMs,
		});

		this.emitEvent(runId, run.workflowName, "RUN_EXPIRED", undefined, undefined, {
			expiresAt: info.expiresAt,
			expiredAt: info.expiredAt,
			lateBy,
		});
	}

	/**
	 * Tier 2 #7 — mark a run as `debounced`. In **leading** mode this is
	 * terminal: the ping was suppressed because a sibling fired
	 * immediately (`intoRunId` carries the sibling's id). In **trailing**
	 * mode this is transient: the same run is marked `debounced` while
	 * the timer is active and flips to `running` when the window closes
	 * (no separate transition method needed — `tracker` updates status
	 * directly via store before invoking the runner).
	 */
	markRunDebounced(
		runId: string,
		info: {
			debounceKey: string;
			mode: "leading" | "trailing";
			intoRunId?: string;
			pingCount?: number;
			scheduledAt?: number;
		},
	): void {
		const run = this.store.getRun(runId);
		if (!run) return;
		// Review fix-up · BUG-1. Don't overwrite a terminal status. A
		// trailing debounce timer firing into a cancelled active run
		// should NOT flip the run back to debounced.
		if (TERMINAL_STATUSES.has(run.status)) return;

		const isTerminal = info.mode === "leading" && info.intoRunId !== undefined;
		const finishedAt = isTerminal ? Date.now() : undefined;
		const durationMs = isTerminal && finishedAt ? finishedAt - run.startedAt : undefined;

		this.store.updateRun(runId, {
			status: "debounced",
			debounceKey: info.debounceKey,
			debounceMode: info.mode,
			pingCount: info.pingCount,
			scheduledAt: info.scheduledAt,
			...(isTerminal ? { finishedAt, durationMs } : {}),
		});

		this.emitEvent(runId, run.workflowName, "RUN_DEBOUNCED", undefined, undefined, {
			debounceKey: info.debounceKey,
			mode: info.mode,
			intoRunId: info.intoRunId,
			pingCount: info.pingCount,
			scheduledAt: info.scheduledAt,
		});
	}

	/**
	 * Tier 2 quick-wins — mark a run as `crashed` (uncaught exception,
	 * OOM, signal). Distinct from `failRun` because the failure was
	 * NOT a step's `process()` throwing — it was the runner itself
	 * giving up. Currently manual; call from custom triggers / ops
	 * harnesses when uncaught failures are detected.
	 */
	markRunCrashed(runId: string, info: { error: Error | unknown }): void {
		const run = this.store.getRun(runId);
		if (!run) return;
		// Review fix-up · BUG-1. Don't overwrite a terminal status. A
		// run that was already cancelled / failed / timedOut shouldn't
		// be flipped to crashed by the boot orphan-recovery pass.
		if (TERMINAL_STATUSES.has(run.status)) return;

		const finishedAt = Date.now();
		const durationMs = finishedAt - run.startedAt;

		this.store.updateRun(runId, {
			status: "crashed",
			finishedAt,
			durationMs,
			error: toRunErrorDetail(info.error),
		});

		this.emitEvent(runId, run.workflowName, "RUN_CRASHED", undefined, undefined, {
			durationMs,
			error: toRunErrorDetail(info.error),
		});
	}

	/**
	 * Tier 2 quick-wins follow-up — bulk-flip every run currently in
	 * `running` status to `crashed`. Returns the count flipped.
	 *
	 * Used by:
	 * - Process-level uncaught-exception handlers
	 *   (`TriggerBase.installCrashHandlers`) — flip in-flight runs
	 *   before the process dies.
	 * - Boot recovery (`TriggerBase.recoverOrphanedRuns`) — flip runs
	 *   that were `running` from the previous (dead) process.
	 *
	 * Synchronous + safe to call from a `process.on("uncaughtException")`
	 * handler (which can't await). Backed by sync sqlite/in-memory
	 * writes that complete before the handler returns.
	 *
	 * Optional `opts.maxStartedAt` filter — only flip runs whose
	 * `startedAt` is at or before this timestamp. Used by boot recovery
	 * to avoid flipping runs from the current (live) process.
	 */
	markAllRunningRunsAsCrashed(error: Error | unknown, opts?: { maxStartedAt?: number }): number {
		// PR 1 follow-up · A1 fix. `getRuns` defaults `opts?.limit ?? 50` in
		// SqliteRunStore — left unbounded, this method silently flips at
		// most 50 orphans per call. Loop until the store returns fewer rows
		// than the page size (= no more matches under the LIMIT).
		//
		// Bounded outer loop: cap at 1000 iterations defensively. With the
		// 50-row page size that's 50K orphans handled per single call —
		// well above any realistic boot-recovery scenario.
		let totalFlipped = 0;
		const PAGE_SIZE = 50; // mirrors SqliteRunStore.getRuns default LIMIT
		const MAX_PAGES = 1000;

		for (let page = 0; page < MAX_PAGES; page++) {
			// Snapshot the runs first — markRunCrashed mutates the store and
			// could perturb iteration if we read+update inline.
			const { runs } = this.store.getRuns({ status: "running" });
			const candidates =
				opts?.maxStartedAt !== undefined ? runs.filter((r) => r.startedAt <= (opts.maxStartedAt as number)) : runs;

			if (candidates.length === 0) break;

			for (const run of candidates) {
				this.markRunCrashed(run.id, { error });
			}
			totalFlipped += candidates.length;

			// If we got fewer rows than the page size, the store has no more
			// matches under the LIMIT — exit early.
			if (runs.length < PAGE_SIZE) break;
		}

		return totalFlipped;
	}

	/**
	 * Tier 2 quick-wins — mark a run as `timedOut` because a step's
	 * final retry attempt exceeded its `maxDuration` cap. Distinct
	 * from `failed` so SLA dashboards can separate timeout-driven
	 * failures (network / capacity) from logic failures (bugs).
	 * Auto-called by `RunnerSteps` on final-attempt `StepTimeoutError`.
	 */
	markRunTimedOut(runId: string, info: { stepId: string; maxDurationMs: number; attemptsExhausted: number }): void {
		const run = this.store.getRun(runId);
		if (!run) return;
		// Review fix-up · BUG-1. Don't overwrite a terminal status — a
		// run that was cancelled mid-step shouldn't flip to timedOut
		// when the maxDuration timer fires after the cancel.
		if (TERMINAL_STATUSES.has(run.status)) return;

		const finishedAt = Date.now();
		const durationMs = finishedAt - run.startedAt;

		this.store.updateRun(runId, {
			status: "timedOut",
			finishedAt,
			durationMs,
		});

		this.emitEvent(runId, run.workflowName, "RUN_TIMED_OUT", undefined, undefined, {
			durationMs,
			stepId: info.stepId,
			maxDurationMs: info.maxDurationMs,
			attemptsExhausted: info.attemptsExhausted,
		});
	}

	/**
	 * Tier 2 #7 — record an additional ping into an existing trailing-mode
	 * debounce window. Increments `pingCount` and updates `scheduledAt`.
	 * Does NOT emit a new event (avoid event-stream bloat under burst).
	 */
	recordDebouncePing(runId: string, opts: { pingCount: number; scheduledAt: number }): void {
		const run = this.store.getRun(runId);
		if (!run) return;
		this.store.updateRun(runId, {
			pingCount: opts.pingCount,
			scheduledAt: opts.scheduledAt,
		});
	}

	/**
	 * Tier 2 #7 — transition a `delayed`/`debounced` run into `running`
	 * when its timer fires. Studio sees the status change via the
	 * existing run-update SSE stream.
	 */
	transitionRunToRunning(runId: string): void {
		const run = this.store.getRun(runId);
		if (!run) return;
		this.store.updateRun(runId, {
			status: "running",
			startedAt: run.startedAt, // preserve the original submission time
		});
	}

	/**
	 * Tier 2 polish — cancel a pending (delayed/debounced/queued) run.
	 * Idempotent. Returns true when the run existed AND was in a cancellable
	 * state; false when the run doesn't exist OR is already running/completed/
	 * failed/throttled/expired/crashed/timedOut/cancelled.
	 *
	 * **Caller responsibility**: this method only updates the run record
	 * (status → `"cancelled"`) and emits `RUN_CANCELLED`. The caller must
	 * separately clear any pending scheduler timers via
	 * `DeferredRunScheduler.getInstance().cancel(runId)` and (when applicable)
	 * `DebounceCoordinator.getInstance().cancel(workflowName, debounceKey)`.
	 * Done this way to avoid an import cycle from tracing → scheduling.
	 */
	cancelRun(runId: string, options?: { cascade?: boolean }): boolean {
		const run = this.store.getRun(runId);
		if (!run) return false;

		// Tier 2 follow-up · "running" added so cooperative AbortSignal
		// cancellation can flip status to "cancelled" before the in-flight
		// step throws `RunCancelledError`. The tracker's `abortRunningRun`
		// calls this method right after firing the AbortController.
		const cancellable = ["delayed", "debounced", "queued", "running"];
		if (!cancellable.includes(run.status)) return false;

		const previousStatus = run.status;
		const finishedAt = Date.now();
		const durationMs = finishedAt - run.startedAt;

		this.store.updateRun(runId, {
			status: "cancelled",
			finishedAt,
			durationMs,
		});

		this.emitEvent(runId, run.workflowName, "RUN_CANCELLED", undefined, undefined, {
			durationMs,
			previousStatus,
		});

		// PR 5 G1 — cascade to fire-and-forget children. Sub-workflow
		// children with `wait: true` (sync) cancel automatically via the
		// AbortSignal chain in createChildContext; children with
		// `wait: false` (async / fire-and-forget) need explicit cascade
		// because the parent step has already returned before the cancel.
		// Walk getRunsByParent recursively (bounded by
		// BLOK_MAX_SUBWORKFLOW_DEPTH).
		if (options?.cascade !== false) {
			const children = this.store.getRunsByParent(runId);
			for (const child of children) {
				if (cancellable.includes(child.status)) {
					// Recursive — bounded by max-depth; each level reduces
					// the candidate pool until none remain.
					this.cancelRun(child.id, { cascade: true });
				}
			}
		}

		return true;
	}

	// === Cooperative cancellation (Tier 2 follow-up) ===

	/**
	 * Per-process map from runId to the AbortController owned by the
	 * trigger's createContext call. Populated by TriggerBase right after
	 * `startRun()`; cleared in TriggerBase's finally block. Used by
	 * `abortRunningRun` to fire the signal when an operator cancels a
	 * `running` run via the cancel API.
	 */
	private abortControllers: Map<string, AbortController> = new Map();

	registerAbortController(runId: string, controller: AbortController): void {
		this.abortControllers.set(runId, controller);
	}

	unregisterAbortController(runId: string): void {
		this.abortControllers.delete(runId);
	}

	/**
	 * Tier 2 follow-up · cooperative cancellation for `running` runs.
	 *
	 * Fires the run's AbortController (so `ctx.signal.aborted` becomes
	 * true and any node consulting it can abort early) AND flips the run
	 * status to `"cancelled"` immediately via `cancelRun`. RunnerSteps'
	 * between-step abort check throws `RunCancelledError` shortly after,
	 * which TriggerBase catches without re-flipping the status.
	 *
	 * Returns true when an AbortController was registered for this run
	 * AND the status was successfully flipped; false otherwise (run not
	 * found, run not in `running` status, or no controller registered —
	 * e.g. controller already cleaned up).
	 */
	abortRunningRun(runId: string): boolean {
		const run = this.store.getRun(runId);
		if (!run || run.status !== "running") return false;

		const controller = this.abortControllers.get(runId);
		if (controller) {
			try {
				controller.abort();
			} catch {
				// AbortController.abort never throws on first call; double-abort is safe.
			}
		}

		// Flip status now so polls return cancelled immediately. The
		// in-flight step's throw will land in TriggerBase.run's catch
		// shortly; the catch sees status is already terminal and skips
		// failRun (RunCancelledError instanceof check).
		return this.cancelRun(runId);
	}

	// === Concurrency gate pass-throughs (Tier 2 #6) ===

	/**
	 * Tier 2 #6 follow-up · cross-process concurrency backend.
	 *
	 * When set (via {@link setConcurrencyBackend}), the tracker's
	 * `acquireConcurrencySlot` and `releaseConcurrencySlot` methods
	 * delegate to the backend instead of the local sync `RunStore` impl.
	 * Used to coordinate across processes via NATS KV / Redis.
	 *
	 * Default `null` — preserves zero-overhead in-process behavior.
	 * Trigger packages install a backend in `listen()` when the operator
	 * sets `BLOK_CONCURRENCY_BACKEND=nats-kv`.
	 */
	private concurrencyBackend: ConcurrencyBackend | null = null;

	setConcurrencyBackend(backend: ConcurrencyBackend | null): void {
		this.concurrencyBackend = backend;
	}

	getConcurrencyBackend(): ConcurrencyBackend | null {
		return this.concurrencyBackend;
	}

	/**
	 * Acquire a concurrency slot for `(workflowName, concurrencyKey)`.
	 * Delegates to the configured cross-process backend when set; falls
	 * back to the local sync `RunStore` impl otherwise.
	 *
	 * Async — the cross-process backend (NATS KV) is async-only. The
	 * sync fallback is wrapped in `Promise.resolve()` so the call site
	 * is uniform.
	 */
	async acquireConcurrencySlot(
		workflowName: string,
		concurrencyKey: string,
		concurrencyLimit: number,
		runId: string,
		leaseExpiresAt: number,
	): Promise<ConcurrencySlotResult> {
		if (this.concurrencyBackend) {
			return this.concurrencyBackend.acquireSlot(workflowName, concurrencyKey, concurrencyLimit, runId, leaseExpiresAt);
		}
		return this.store.acquireConcurrencySlot(workflowName, concurrencyKey, concurrencyLimit, runId, leaseExpiresAt);
	}

	/** Release a slot acquired via `acquireConcurrencySlot`. Idempotent. */
	async releaseConcurrencySlot(workflowName: string, concurrencyKey: string, runId: string): Promise<void> {
		if (this.concurrencyBackend) {
			await this.concurrencyBackend.releaseSlot(workflowName, concurrencyKey, runId);
			return;
		}
		this.store.releaseConcurrencySlot(workflowName, concurrencyKey, runId);
	}

	// === Node Lifecycle ===

	startNode(runId: string, opts: StartNodeOptions): NodeRun {
		const nodeRun: NodeRun = {
			id: `node_${uuid().replace(/-/g, "").slice(0, 12)}`,
			runId,
			nodeName: opts.nodeName,
			nodeType: opts.nodeType,
			runtimeKind: opts.runtimeKind,
			status: "running",
			startedAt: Date.now(),
			inputs: opts.inputs,
			parentNodeId: opts.parentNodeId,
			depth: opts.depth,
			stepIndex: opts.stepIndex,
			wait: opts.wait,
			subworkflowDepth: opts.subworkflowDepth,
			middleware: opts.middleware,
			iterationIndex: opts.iterationIndex,
		};

		this.store.saveNodeRun(nodeRun);

		const run = this.store.getRun(runId);
		this.emitEvent(runId, run?.workflowName || "", "NODE_STARTED", opts.nodeName, nodeRun.id, {
			nodeType: opts.nodeType,
			runtimeKind: opts.runtimeKind,
			stepIndex: opts.stepIndex,
			depth: opts.depth,
		});

		return nodeRun;
	}

	completeNode(nodeRunId: string, outputs?: unknown, nodeMetrics?: NodeRun["metrics"]): void {
		const nodeRun = this.store.getNodeRun(nodeRunId);
		if (!nodeRun) return;

		const finishedAt = Date.now();
		const durationMs = finishedAt - nodeRun.startedAt;

		this.store.updateNodeRun(nodeRunId, {
			status: "completed",
			finishedAt,
			durationMs,
			outputs,
			metrics: nodeMetrics,
		});

		const run = this.store.getRun(nodeRun.runId);
		if (run) {
			this.store.updateRun(nodeRun.runId, {
				completedNodes: run.completedNodes + 1,
			});
		}

		this.emitEvent(nodeRun.runId, run?.workflowName || "", "NODE_COMPLETED", nodeRun.nodeName, nodeRunId, {
			durationMs,
			metrics: nodeMetrics,
		});
	}

	/**
	 * Tier 1 idempotency cache hit. Marks the node as completed without
	 * having actually run, attaches the source-run/source-node lineage so
	 * Studio can render a CACHED badge with click-through, and emits a
	 * `NODE_CACHED` event so SSE subscribers see the short-circuit live.
	 *
	 * Caller is responsible for replaying the cached result through
	 * `PersistenceHelper.applyStepOutput` — this method only records the
	 * tracing side. Caching layers ABOVE persistence, never within it.
	 */
	markNodeCached(
		nodeRunId: string,
		source: { sourceRunId: string; sourceNodeRunId: string; cachedAt: number },
		outputs?: unknown,
	): void {
		const nodeRun = this.store.getNodeRun(nodeRunId);
		if (!nodeRun) return;

		const finishedAt = Date.now();
		const durationMs = finishedAt - nodeRun.startedAt;

		// Security review FW-10 — the idempotency cache holds raw step
		// output (correct: downstream steps need actual values to run),
		// but trace storage of a cache hit must mirror the live-run path
		// where `completeNode` calls `sanitize(ctx.response.data)`.
		// Without this, a cached step's outputs row could contain raw
		// `password`/`token` fields that the live run would have redacted.
		const sanitizedOutputs = outputs === undefined ? undefined : sanitize(outputs);

		this.store.updateNodeRun(nodeRunId, {
			status: "completed",
			finishedAt,
			durationMs,
			outputs: sanitizedOutputs,
			cached: { ...source },
		});

		const run = this.store.getRun(nodeRun.runId);
		if (run) {
			this.store.updateRun(nodeRun.runId, {
				completedNodes: run.completedNodes + 1,
			});
		}

		this.emitEvent(nodeRun.runId, run?.workflowName || "", "NODE_CACHED", nodeRun.nodeName, nodeRunId, {
			durationMs,
			source: { ...source },
		});
	}

	/**
	 * Tier 1 retry: record a single failed attempt before the next retry. The
	 * node stays in `running` status — `failNode` is the terminal call that
	 * fires only after `retry.maxAttempts` is exhausted.
	 *
	 * Per-node attempt history is capped at {@link MAX_STORED_ATTEMPTS} (10)
	 * to bound store growth on extreme retry counts. The cap matches the
	 * risk-register decision in `tier1-idempotency-replay-retry.md`.
	 */
	recordNodeAttemptFailed(nodeRunId: string, info: { attempt: number; error: unknown }): void {
		const nodeRun = this.store.getNodeRun(nodeRunId);
		if (!nodeRun) return;
		const errorDetail = toRunErrorDetail(info.error);
		const next = [...(nodeRun.attempts ?? []), { attempt: info.attempt, error: errorDetail, timestamp: Date.now() }];
		const capped = next.length > MAX_STORED_ATTEMPTS ? next.slice(-MAX_STORED_ATTEMPTS) : next;
		this.store.updateNodeRun(nodeRunId, { attempts: capped });

		const run = this.store.getRun(nodeRun.runId);
		this.emitEvent(nodeRun.runId, run?.workflowName || "", "NODE_ATTEMPT_FAILED", nodeRun.nodeName, nodeRunId, {
			attempt: info.attempt,
			error: errorDetail,
		});
	}

	failNode(nodeRunId: string, error: Error | unknown): void {
		const nodeRun = this.store.getNodeRun(nodeRunId);
		if (!nodeRun) return;

		const finishedAt = Date.now();
		const durationMs = finishedAt - nodeRun.startedAt;
		const errorDetail = toRunErrorDetail(error);

		this.store.updateNodeRun(nodeRunId, {
			status: "failed",
			finishedAt,
			durationMs,
			error: errorDetail,
		});

		const run = this.store.getRun(nodeRun.runId);
		this.emitEvent(nodeRun.runId, run?.workflowName || "", "NODE_FAILED", nodeRun.nodeName, nodeRunId, {
			durationMs,
			error: errorDetail,
		});
	}

	skipNode(runId: string, nodeName: string, stepIndex: number, reason?: string): void {
		const run = this.store.getRun(runId);
		this.emitEvent(runId, run?.workflowName || "", "NODE_SKIPPED", nodeName, undefined, {
			reason,
			stepIndex,
		});
	}

	/**
	 * Record a streaming `Progress` frame for an in-flight node. Overwrites
	 * any previous progress (only the latest milestone is preserved on
	 * the {@link NodeRun} record). Emits a `NODE_PROGRESS` event so SSE
	 * subscribers (Studio) get the live update too.
	 *
	 * Master plan §17 Phase 5 follow-up — wires the proto `Progress`
	 * frame from `ExecuteStream` into the trace store + Studio.
	 *
	 * @param percent 0–100; values outside the range are clamped.
	 * @param phase optional free-form phase label (may be empty).
	 */
	recordProgress(nodeRunId: string, percent: number, phase: string): void {
		const nodeRun = this.store.getNodeRun(nodeRunId);
		if (!nodeRun) return;

		const clamped = Math.max(0, Math.min(100, Math.round(percent)));
		const updatedAt = Date.now();

		this.store.updateNodeRun(nodeRunId, {
			progress: {
				percent: clamped,
				phase: phase ?? "",
				updatedAt,
			},
		});

		const run = this.store.getRun(nodeRun.runId);
		this.emitEvent(nodeRun.runId, run?.workflowName || "", "NODE_PROGRESS", nodeRun.nodeName, nodeRunId, {
			percent: clamped,
			phase: phase ?? "",
			updatedAt,
		});
	}

	/**
	 * Record a streaming `PartialResult` snapshot for an in-flight node.
	 * Overwrites any previous snapshot. Emits a `NODE_PARTIAL_RESULT`
	 * event for SSE subscribers.
	 *
	 * Master plan §17 Phase 5 follow-up.
	 */
	recordPartialResult(nodeRunId: string, snapshot: unknown): void {
		const nodeRun = this.store.getNodeRun(nodeRunId);
		if (!nodeRun) return;

		const updatedAt = Date.now();
		this.store.updateNodeRun(nodeRunId, {
			partialResult: { snapshot, updatedAt },
		});

		const run = this.store.getRun(nodeRun.runId);
		this.emitEvent(nodeRun.runId, run?.workflowName || "", "NODE_PARTIAL_RESULT", nodeRun.nodeName, nodeRunId, {
			snapshot,
			updatedAt,
		});
	}

	// === Logging ===

	addLog(entry: Omit<TraceLogEntry, "id" | "timestamp">): void {
		// Security review FW-6 — pipe arbitrary log payload through
		// the sensitive-field redactor before persisting or emitting.
		// `ctx.logger.logLevel("warn", "x", { password: "..." })` lands
		// here; without sanitize the secret would persist + stream via
		// SSE to anyone with /__blok/runs/:id/events access.
		const sanitizedData =
			entry.data === undefined ? undefined : (sanitize(entry.data) as Record<string, unknown> | undefined);

		const log: TraceLogEntry = {
			id: `log_${uuid().replace(/-/g, "").slice(0, 12)}`,
			...entry,
			data: sanitizedData,
			timestamp: Date.now(),
		};

		this.store.saveLog(log);

		const run = this.store.getRun(entry.runId);
		this.emitEvent(entry.runId, run?.workflowName || "", "LOG_ENTRY", entry.nodeName, entry.nodeId, {
			level: entry.level,
			message: entry.message,
			data: sanitizedData,
		});
	}

	// === Vars Updated ===

	trackVarsUpdate(runId: string, nodeName: string, nodeId: string | undefined, vars: Record<string, unknown>): void {
		const run = this.store.getRun(runId);
		this.emitEvent(runId, run?.workflowName || "", "VARS_UPDATED", nodeName, nodeId, { vars });
	}

	// === Queries (delegated to store) ===

	getRun(runId: string): WorkflowRun | undefined {
		return this.store.getRun(runId);
	}

	getRuns(opts?: RunQuery): { runs: WorkflowRun[]; total: number } {
		return this.store.getRuns(opts);
	}

	getNodeRuns(runId: string): NodeRun[] {
		return this.store.getNodeRuns(runId);
	}

	getNodeRun(nodeRunId: string): NodeRun | undefined {
		return this.store.getNodeRun(nodeRunId);
	}

	getEvents(runId: string, since?: number): RunEvent[] {
		return this.store.getEvents(runId, since);
	}

	/**
	 * Tier 2 sub-workflow lineage. Returns every run that was started by
	 * a `subworkflow:` step inside the given parent run. Powers Studio's
	 * "Sub-runs" list on a parent's run-detail page.
	 */
	getRunsByParent(parentRunId: string): WorkflowRun[] {
		return this.store.getRunsByParent(parentRunId);
	}

	getLogs(runId: string, nodeId?: string): TraceLogEntry[] {
		return this.store.getLogs(runId, nodeId);
	}

	// === Metadata (delegated to store) ===

	getWorkflowSummaries(): WorkflowSummary[] {
		return this.store.getWorkflowSummaries();
	}

	// === Tags ===

	addTag(runId: string, tag: string): boolean {
		const run = this.store.getRun(runId);
		if (!run) return false;
		const tags = run.tags || [];
		if (tags.includes(tag)) return false;
		tags.push(tag);
		this.store.updateRun(runId, { tags });
		return true;
	}

	removeTag(runId: string, tag: string): boolean {
		const run = this.store.getRun(runId);
		if (!run || !run.tags) return false;
		const idx = run.tags.indexOf(tag);
		if (idx === -1) return false;
		const tags = [...run.tags];
		tags.splice(idx, 1);
		this.store.updateRun(runId, { tags });
		return true;
	}

	getAllTags(): string[] {
		return this.store.getAllTags();
	}

	// === Metrics Aggregation (delegated to store) ===

	getMetrics(workflow?: string): MetricsResult {
		return this.store.getMetrics(workflow);
	}

	// === Utility ===

	getActiveRunCount(): number {
		return this.store.getActiveRunCount();
	}

	clearAll(): number {
		return this.store.clearAll();
	}

	// === Dashboards (delegated to store) ===

	saveDashboard(dashboard: Dashboard): void {
		this.store.saveDashboard(dashboard);
	}

	getDashboard(dashboardId: string): Dashboard | undefined {
		return this.store.getDashboard(dashboardId);
	}

	listDashboards(): Dashboard[] {
		return this.store.listDashboards();
	}

	deleteDashboard(dashboardId: string): boolean {
		return this.store.deleteDashboard(dashboardId);
	}

	updateDashboard(dashboardId: string, updates: Partial<Dashboard>): void {
		this.store.updateDashboard(dashboardId, updates);
	}

	// === Saved filters (E2, delegated to store) ===

	upsertSavedFilter(filter: SavedFilter): SavedFilter {
		return this.store.upsertSavedFilter(filter);
	}

	listSavedFilters(): SavedFilter[] {
		return this.store.listSavedFilters();
	}

	deleteSavedFilter(name: string): boolean {
		return this.store.deleteSavedFilter(name);
	}

	// === Sample-body recording (option C, delegated to store) ===

	recordWorkflowSample(sample: WorkflowSample): WorkflowSample {
		return this.store.recordWorkflowSample(sample);
	}

	getWorkflowSample(workflowName: string): WorkflowSample | undefined {
		return this.store.getWorkflowSample(workflowName);
	}

	deleteWorkflowSample(workflowName: string): boolean {
		return this.store.deleteWorkflowSample(workflowName);
	}

	// === Webhooks ===

	registerWebhook(opts: { url: string; events: string[]; secret?: string }): Webhook {
		const webhook: Webhook = {
			id: `wh_${uuid().replace(/-/g, "").slice(0, 12)}`,
			url: opts.url,
			events: opts.events,
			secret: opts.secret,
			createdAt: Date.now(),
			active: true,
			failCount: 0,
		};
		this.webhooks.set(webhook.id, webhook);
		return webhook;
	}

	removeWebhook(id: string): boolean {
		return this.webhooks.delete(id);
	}

	getWebhooks(): Webhook[] {
		return Array.from(this.webhooks.values());
	}

	// === Internal ===

	private emitEvent(
		runId: string,
		workflowName: string,
		type: RunEventType,
		nodeName?: string,
		nodeId?: string,
		payload?: unknown,
	): void {
		const event: RunEvent = {
			id: `evt_${uuid().replace(/-/g, "").slice(0, 12)}`,
			type,
			runId,
			workflowName,
			timestamp: Date.now(),
			nodeName,
			nodeId,
			payload,
		};

		this.store.saveEvent(event);

		this.emit("event", event);
		this.emit(type, event);

		// Fire webhooks for relevant events
		this.fireWebhooks(event);
	}

	private fireWebhooks(event: RunEvent): void {
		const eventMap: Record<string, string> = {
			RUN_STARTED: "run.started",
			RUN_COMPLETED: "run.completed",
			RUN_FAILED: "run.failed",
		};
		const webhookEvent = eventMap[event.type];
		if (!webhookEvent) return;

		for (const webhook of this.webhooks.values()) {
			if (!webhook.active) continue;
			if (!webhook.events.includes(webhookEvent)) continue;

			const body = JSON.stringify({
				event: webhookEvent,
				timestamp: event.timestamp,
				run: this.store.getRun(event.runId),
				webhookId: webhook.id,
			});

			const headers: Record<string, string> = { "Content-Type": "application/json" };
			if (webhook.secret) {
				headers["X-Blok-Signature"] = crypto.createHmac("sha256", webhook.secret).update(body).digest("hex");
			}

			// Fire-and-forget HTTP POST
			const parsed = new URL(webhook.url);
			const client = parsed.protocol === "https:" ? https : http;

			const req = client.request(
				{
					hostname: parsed.hostname,
					port: parsed.port,
					path: parsed.pathname + parsed.search,
					method: "POST",
					headers,
					timeout: 5000,
				},
				(res) => {
					webhook.lastTriggeredAt = Date.now();
					webhook.lastStatus = res.statusCode;
					if (res.statusCode && res.statusCode >= 400) {
						webhook.failCount++;
						if (webhook.failCount >= 10) webhook.active = false;
					} else {
						webhook.failCount = 0;
					}
					res.resume(); // consume body
				},
			);

			req.on("error", () => {
				webhook.lastTriggeredAt = Date.now();
				webhook.failCount++;
				if (webhook.failCount >= 10) webhook.active = false;
			});

			req.write(body);
			req.end();
		}
	}
}
