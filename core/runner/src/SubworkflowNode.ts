import type { Context, ResponseContext } from "@blokjs/shared";
import Configuration from "./Configuration";
import RunnerNode from "./RunnerNode";
import { RunTracker } from "./tracing/RunTracker";
import type GlobalOptions from "./types/GlobalOptions";
import { createChildContext } from "./utils/createChildContext";
import { applyStepOutput } from "./workflow/PersistenceHelper";
import { WorkflowRegistry } from "./workflow/WorkflowRegistry";

/**
 * Hard cap on `parent → child → grandchild → …` recursion. Bounds the
 * blast radius of an accidental cycle (workflow A calls B calls A) or
 * a legitimate-but-pathological deep nesting. Tunable via
 * `BLOK_MAX_SUBWORKFLOW_DEPTH` env var; falls back to 10.
 */
function getMaxDepth(): number {
	const raw = process.env.BLOK_MAX_SUBWORKFLOW_DEPTH;
	if (typeof raw === "string" && raw.length > 0) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isInteger(parsed) && parsed > 0) return parsed;
	}
	return 10;
}

/**
 * Internal ctx field that carries the current sub-workflow depth.
 * Incremented by `SubworkflowNode.run` before invoking the child;
 * read on entry to enforce the cap.
 */
const SUBWORKFLOW_DEPTH_KEY = "_subworkflowDepth";

/**
 * `SubworkflowNode` — the runner-side dispatch primitive that powers
 * the v2 `subworkflow:` step shape. Looks up the named child workflow
 * in the `WorkflowRegistry`, materializes a child `Configuration` +
 * `Runner`, runs the child to completion in its own isolated `Context`,
 * and returns the child's `ctx.response` as this step's `model.data`.
 *
 * **Composition with Tier 1**:
 * - Parent step's `idempotencyKey` is consulted by `RunnerSteps` BEFORE
 *   `SubworkflowNode.run` is even called — cache hit short-circuits the
 *   entire sub-workflow (no child invocation, no side effects fire).
 *   This is the headline pattern AND the documented footgun.
 * - Parent step's `retry` retries the whole sub-workflow on failure;
 *   each retry creates a fresh child run record under the same parent.
 * - Replay re-creates fresh sub-run lineage automatically — the new
 *   parent run invokes the sub-workflow fresh.
 *
 * **Lineage**: child's `WorkflowRun.parentRunId` and
 * `WorkflowRun.parentNodeRunId` carry the parent run + step that
 * invoked it. Studio renders a "called from #..." breadcrumb on the
 * child and a "Sub-runs" list on the parent.
 *
 * **Recursion guard**: `BLOK_MAX_SUBWORKFLOW_DEPTH` (default 10) bounds
 * cycle / deep-nesting blast radius. Throws a clear error past the cap.
 */
export class SubworkflowNode extends RunnerNode {
	/**
	 * The child workflow's `name:` field — looked up in `WorkflowRegistry`
	 * at run time. Set by `Configuration.subworkflowResolver`; this field
	 * shadows the inherited `NodeBase.subworkflow` so callers can rely on
	 * it being defined.
	 */
	public declare subworkflow: string;
	/**
	 * Wait mode for the sub-workflow dispatch:
	 *
	 * - `true` (default) — synchronous: parent step blocks on the child
	 *   and the child's `ctx.response` becomes the parent step's output.
	 * - `false` — fire-and-forget: parent step returns IMMEDIATELY with
	 *   `{runId, workflowName, scheduledAt}`. The child runs
	 *   asynchronously via `setImmediate` and shows up in Studio's
	 *   Sub-runs strip with status transitioning `running → completed |
	 *   failed` independently of the parent.
	 *
	 * Combine `wait: false` with `idempotencyKey` for at-most-once
	 * dispatch deduplication (the `runId` is cached against the key
	 * regardless of child outcome — Trigger.dev / Stripe semantics).
	 */
	public declare wait: boolean;
	/**
	 * Runner-wide options (carries the `nodes` registry that the child
	 * Configuration needs for `module` step resolution). Set by
	 * `Configuration.subworkflowResolver` before this node runs.
	 */
	public globalOptions?: GlobalOptions;

	async run(ctx: Context): Promise<ResponseContext> {
		// === 1. Recursion guard ===
		const depth = (((ctx as Record<string, unknown>)[SUBWORKFLOW_DEPTH_KEY] as number) ?? 0) + 1;
		const maxDepth = getMaxDepth();
		if (depth > maxDepth) {
			throw new Error(
				`[blok] Sub-workflow recursion limit exceeded (depth ${depth} > ${maxDepth}). Likely a cycle: workflow "${ctx.workflow_name}" called sub-workflow "${this.subworkflow}" too deep. Bump via BLOK_MAX_SUBWORKFLOW_DEPTH if intentional.`,
			);
		}

		// === 2. Look up the child workflow ===
		const registry = WorkflowRegistry.getInstance();
		const entry = registry.get(this.subworkflow);
		if (!entry) {
			const known = registry.list().map((w) => w.name);
			const knownStr = known.length > 0 ? known.join(", ") : "(none registered yet)";
			throw new Error(
				`[blok] Sub-workflow "${this.subworkflow}" not found in WorkflowRegistry. Available: ${knownStr}. Workflows are registered automatically by the HTTP trigger at boot — make sure the child workflow file is in the scanned directory and has \`name: "${this.subworkflow}"\`.`,
			);
		}

		// === 2.5. Registry-level authorization ===
		// Default-allow when no hook is installed (preserves pre-v0.4.1
		// behavior). Operators install a hook via
		// WorkflowRegistry.getInstance().setAuthorizeFn(...) for
		// multi-tenant access control. Throws on denial; the parent
		// step's retry loop (if any) will retry — author should pin
		// `retry: undefined` on sub-workflow steps where denial is
		// permanent.
		const allowed = await registry.authorize(ctx.workflow_name ?? "<unknown>", this.subworkflow, ctx);
		if (!allowed) {
			throw new Error(
				`[blok] Sub-workflow access denied: workflow "${ctx.workflow_name}" is not authorized to invoke "${this.subworkflow}". This denial came from the registry-level authorize hook (WorkflowRegistry.setAuthorizeFn). Adjust the hook to allow this composition, or remove the gate.`,
			);
		}

		// === 3. Materialize child Configuration + Runner ===
		// `preloaded` = entry.workflow skips the disk re-read; the
		// normalizer still runs so v1→v2 conversion happens for legacy
		// child workflows.
		const childConfig = new Configuration();
		await childConfig.init(entry.name, this.globalOptions, entry.workflow);
		// Lazy import of Runner to avoid a circular dep
		// (Configuration → RunnerNode → ... — Runner has its own chain).
		const { default: Runner } = await import("./Runner");
		const childRunner = new Runner(childConfig.steps);

		// === 4. Build the child Context ===
		// Parent step's resolved inputs (from blueprint mapper) live on
		// `ctx.config[this.name].inputs` — the blueprint mapper has
		// mutated the wrapper in place, so `js/...` and `$.<path>`
		// expressions are now concrete values. These become the child's
		// `request.body` so the child reads them via `$.req.body.<key>`
		// exactly as if HTTP-triggered (function-call semantics).
		const parentNodeConfig = (ctx.config as Record<string, { inputs?: unknown }> | undefined)?.[this.name];
		const parentInputs = parentNodeConfig?.inputs ?? {};
		const childCtx = createChildContext(ctx, {
			workflowName: entry.name,
			workflowPath: entry.source,
			body: parentInputs,
			config: childConfig.nodes,
		});
		// Carry the depth counter forward so nested sub-workflows hit the cap.
		(childCtx as Record<string, unknown>)[SUBWORKFLOW_DEPTH_KEY] = depth;

		// === 5. Tracing — child gets its own run record + lineage ===
		const tracker = RunTracker.getInstance();
		const parentRunId = (ctx as Record<string, unknown>)._traceRunId as string | undefined;
		const parentNodeRunId = (ctx as Record<string, unknown>)._traceNodeId as string | undefined;
		const childTriggerSummary = `${ctx.workflow_name ?? "?"} → ${entry.name}`;

		let childRunId: string | undefined;
		if (tracker.active) {
			const childRun = tracker.startRun({
				workflowName: entry.name,
				workflowPath: entry.source,
				triggerType: "subworkflow",
				triggerSummary: childTriggerSummary,
				nodeCount: childConfig.steps.length,
				parentRunId,
				parentNodeRunId,
			});
			childRunId = childRun.id;
			(childCtx as Record<string, unknown>)._traceRunId = childRun.id;
		}

		// === 6. Dispatch — sync or fire-and-forget based on `this.wait` ===
		if (this.wait === false) {
			return this.dispatchAsync(ctx, childRunner, childCtx, childRunId, entry.name);
		}

		// === 6a. Synchronous dispatch (wait: true / default) ===
		try {
			await childRunner.run(childCtx);
			if (childRunId) tracker.completeRun(childRunId, childCtx.response);
		} catch (err) {
			if (childRunId) tracker.failRun(childRunId, err);
			throw err;
		} finally {
			// PR 1 follow-up · A3 fix. Abort the listener-cleanup signal so
			// the parent.signal listener (registered in createChildContext)
			// auto-removes. Without this, listeners accumulate on long-lived
			// parents that fire many sub-workflows.
			const childPrivate = childCtx._PRIVATE_ as { listenerCleanup?: AbortController } | null;
			if (childPrivate?.listenerCleanup && !childPrivate.listenerCleanup.signal.aborted) {
				childPrivate.listenerCleanup.abort();
			}
		}

		// === 7. Apply parent persistence + return child's response ===
		// Mirrors HTTP function-call semantics: parent reads child output
		// at `$.state[<this.name>]`. Child author controls the shape via
		// `@blokjs/respond` (or the last step's natural output).
		//
		// Persistence-helper call mirrors the RuntimeAdapterNode pattern
		// (RuntimeAdapterNode.ts:100). The parent step's `as` / `spread`
		// / `ephemeral` knobs apply identically here — sub-workflow
		// output is just data, persistence rules are uniform.
		const result = { success: !childCtx.response?.error, data: childCtx.response };
		applyStepOutput(ctx, this, result);
		return {
			success: result.success,
			data: childCtx.response,
			error: childCtx.response?.error ?? null,
		};
	}

	/**
	 * Fire-and-forget dispatch (Tier 2 #4 follow-up — `wait: false`).
	 *
	 * Schedules the child runner via `setImmediate` so the parent step
	 * can return immediately. Child errors are caught and routed to
	 * `tracker.failRun(childRunId, err)` — visible in Studio, NOT
	 * propagated to the parent step (which has already returned). Also
	 * logged via `console.error` for ops visibility.
	 *
	 * Parent step's output is the dispatch metadata `{runId,
	 * workflowName, scheduledAt}` — NOT the child's response (which
	 * doesn't exist yet). Caller polls `GET /__blok/runs/<runId>` for
	 * the actual outcome.
	 */
	private dispatchAsync(
		parentCtx: Context,
		childRunner: { run: (ctx: Context) => Promise<unknown> },
		childCtx: Context,
		childRunId: string | undefined,
		childWorkflowName: string,
	): ResponseContext {
		const scheduledAt = Date.now();
		const tracker = RunTracker.getInstance();

		setImmediate(() => {
			void (async () => {
				try {
					await childRunner.run(childCtx);
					if (childRunId) tracker.completeRun(childRunId, childCtx.response);
				} catch (err) {
					if (childRunId) {
						tracker.failRun(childRunId, err instanceof Error ? err : new Error(String(err)));
					}
					console.error(
						`[blok][subworkflow] async child '${childWorkflowName}' (run ${childRunId ?? "?"}) failed:`,
						err instanceof Error ? err.stack || err.message : err,
					);
				} finally {
					// PR 1 follow-up · A3 fix. Same listener-cleanup hook as the
					// sync path so async sub-workflows also auto-remove the
					// parent.signal listener on completion.
					const childPrivate = childCtx._PRIVATE_ as { listenerCleanup?: AbortController } | null;
					if (childPrivate?.listenerCleanup && !childPrivate.listenerCleanup.signal.aborted) {
						childPrivate.listenerCleanup.abort();
					}
				}
			})();
		});

		// Parent step's output: dispatch metadata (the runId is the
		// canonical handle for at-most-once dispatch deduplication when
		// combined with `idempotencyKey`).
		const dispatchData: Record<string, unknown> = {
			runId: childRunId ?? null,
			workflowName: childWorkflowName,
			scheduledAt,
		};
		const result = { success: true, data: dispatchData };
		applyStepOutput(parentCtx, this, result);
		return {
			success: true,
			data: dispatchData,
			error: null,
		};
	}
}
