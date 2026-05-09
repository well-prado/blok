import { type Context, GlobalError, type NodeBase, type Step } from "@blokjs/shared";
import type BlokResponse from "./BlokResponse";
import { RunCancelledError } from "./RunCancelledError";
import { WaitDispatchRequest } from "./WaitDispatchRequest";
import { resolveIdempotencyKey } from "./idempotency/resolveIdempotencyKey";
import { StepTimeoutError } from "./timeouts/StepTimeoutError";
import { RunTracker } from "./tracing/RunTracker";
import { sanitize } from "./tracing/sanitize";
import { applyStepOutput } from "./workflow/PersistenceHelper";

/**
 * Default TTL for idempotency cache entries when the step author does not
 * pass `idempotencyKeyTTL` explicitly. 24 hours, matching Trigger.dev's
 * default and the decision recorded in the Tier 1 ROADMAP session.
 */
const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Compute the delay before retry attempt N+1 using capped exponential
 * backoff. Mirrors Trigger.dev's `retry` semantics — no jitter by default.
 *
 * `delay = min(maxTimeoutInMs, minTimeoutInMs * factor^(attempt - 1))`
 *
 * Defaults: min=1000, max=30000, factor=2 — same as Trigger.dev.
 */
function computeBackoff(
	config: { minTimeoutInMs?: number; maxTimeoutInMs?: number; factor?: number },
	attempt: number,
): number {
	const min = config.minTimeoutInMs ?? 1000;
	const max = config.maxTimeoutInMs ?? 30000;
	const factor = config.factor ?? 2;
	const raw = min * factor ** Math.max(0, attempt - 1);
	return Math.min(max, Math.floor(raw));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Tier 2 quick-wins — wrap a Promise in a setTimeout-based timeout
 * race. On timeout, rejects with `StepTimeoutError`. The underlying
 * `fn()` continues to run (no AbortSignal cancellation in v1) but
 * the runner has already moved on — orphaned resolution settles
 * harmlessly into the void.
 */
function wrapWithTimeout<T>(fn: () => Promise<T>, ms: number, stepName: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new StepTimeoutError(stepName, ms));
		}, ms);
		fn().then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

export default abstract class RunnerSteps {
	/**
	 * Executes a series of steps in the given context.
	 *
	 * @param ctx - The context in which the steps are executed.
	 * @param steps - An array of BlokService steps to be executed.
	 * @param deep - A boolean indicating whether the function is being called recursively for flow steps.
	 * @param step_name - The name of the current step being processed in a flow.
	 * @returns A promise that resolves to the updated context after all steps have been executed.
	 * @throws {GlobalError} Throws a GlobalError if any step results in an error.
	 */
	async runSteps(ctx: Context, steps: NodeBase[], deep = false, step_name = ""): Promise<Context> {
		ctx.config = { ...ctx.config };

		const traceRunId = (ctx as Record<string, unknown>)._traceRunId as string | undefined;
		const tracker = traceRunId ? RunTracker.getInstance() : null;
		const depthLevel = deep ? 1 : 0;

		try {
			ctx.logger.log(`Starting runner for ${steps.length} steps ${!deep ? "(Parent)" : `(${step_name})`}`);
			let flow = false;
			let flow_steps: NodeBase[] = [];
			let flow_step = 0;
			let stepName = "";

			// PR 4 — wait.for / wait.until resume cursor.
			//
			// On `dispatchDeferred` re-entry from a wait step, the runner
			// must skip past pre-wait steps that already completed in the
			// previous pass. `lastCompletedStepIndex` is set on the run
			// record before each WaitDispatchRequest throw and read here
			// at runSteps entry. Default `-1` = no resume; runner starts
			// at i = 0.
			const persistedRun = !deep && tracker && traceRunId ? tracker.getStore().getRun(traceRunId) : undefined;
			const resumeFromIndex =
				persistedRun?.lastCompletedStepIndex !== undefined ? persistedRun.lastCompletedStepIndex + 1 : 0;

			for (let i = 0; i < steps.length; i++) {
				const step: NodeBase = steps[i];

				// PR 4 — skip pre-wait steps on resume. State + NodeRuns
				// from the first pass are still on `ctx.state` / in the
				// store; the runner just advances past them.
				if (i < resumeFromIndex) {
					ctx.logger.log(
						`[step ${i + 1}/${steps.length}] ${step.name} → skipped (resumed past wait at lastCompletedStepIndex=${persistedRun?.lastCompletedStepIndex})`,
					);
					continue;
				}

				// Tier 2 follow-up · cooperative cancellation. Operators can
				// abort `running` runs via `POST /__blok/runs/:runId/cancel`,
				// which fires the ctx's AbortController. The check is between
				// steps so a long-running step's `step.process()` doesn't have
				// to consult the signal itself (though nodes that want finer
				// granularity can read `ctx.signal.aborted` themselves).
				if (ctx.signal?.aborted) {
					throw new RunCancelledError(traceRunId);
				}

				if (!step.active) {
					// Track skipped nodes
					if (tracker && traceRunId) {
						tracker.skipNode(traceRunId, step.name, i, "inactive");
					}
					continue;
				}
				if (step.stop) break;
				ctx.response.contentType = step.contentType;

				if (!step.flow) {
					// --- Trace: start node ---
					let nodeRunId: string | undefined;
					const stepAny = step as unknown as Record<string, unknown>;
					const stepType = (stepAny.type as string) || "unknown";
					// Runtime nodes (RuntimeAdapterNode) expose `transport` so
					// operators can tell at a glance whether the step ran via
					// HTTP, gRPC, or in-process module nodes. Module/local
					// nodes don't carry the field — prefix stays one-tag.
					const transport = stepAny.transport as string | undefined;
					const stepPrefix = transport
						? `[step ${i + 1}/${steps.length}] ${step.name} (${stepType}, ${transport})`
						: `[step ${i + 1}/${steps.length}] ${step.name} (${stepType})`;

					// --- Step metadata for runtime adapters ---
					// Populate `ctx._stepInfo` so adapters (e.g. GrpcRuntimeAdapter)
					// can report the step's position in the workflow without each
					// adapter having to plumb its own counter. Set unconditionally —
					// independent of whether tracing is enabled.
					(ctx as Record<string, unknown>)._stepInfo = {
						name: step.name,
						index: i,
						total: steps.length,
						depth: depthLevel,
					};

					if (tracker && traceRunId) {
						const configAny = ctx.config as unknown as Record<string, Record<string, unknown>>;
						// Tier 2 #4 sub-workflow: capture the `wait` mode so
						// Studio can render `↳ async` (wait:false) vs `↳ sub`
						// (wait:true / default) in StepRail. Only meaningful
						// for subworkflow steps; undefined elsewhere.
						const subworkflowWait = stepType === "subworkflow" ? (stepAny.wait as boolean | undefined) : undefined;
						// PR 5 E3 — surface sub-workflow nesting depth.
						// `_subworkflowDepth` on ctx is set by SubworkflowNode +
						// createChildContext; the parent's invocation of a
						// child step has depth = parent.depth + 1. Top-level =
						// 1; nested = 2+. Only meaningful for subworkflow steps.
						const subworkflowDepth =
							stepType === "subworkflow"
								? (((ctx as Record<string, unknown>)._subworkflowDepth as number | undefined) ?? 0) + 1
								: undefined;
						// v0.5 middleware origin tagging — when the trigger's
						// `runMiddlewareChain` is dispatching a middleware
						// workflow on this ctx, it sets `_blokMiddlewareName`
						// to the middleware's name. Surface that here so
						// Studio's StepRail can render a `mw:<name>` origin
						// badge on every inner step the middleware produced.
						const middleware = (ctx as Record<string, unknown>)._blokMiddlewareName as string | undefined;
						const nodeRun = tracker.startNode(traceRunId, {
							nodeName: step.name,
							nodeType: stepType,
							runtimeKind: stepAny.runtime as string | undefined,
							inputs: sanitize(configAny?.[step.name]?.inputs ?? stepAny.config),
							depth: depthLevel,
							stepIndex: i,
							wait: subworkflowWait,
							subworkflowDepth,
							middleware,
						});
						nodeRunId = nodeRun.id;
						(ctx as Record<string, unknown>)._traceNodeId = nodeRunId;
					}

					// === PR 4: wait.for(duration) / wait.until(date) step ===
					// Two paths:
					//   1. First pass: compute deadline, mark NodeRun complete
					//      (the wait step has no `process()` body), set the
					//      run's resume cursor (lastCompletedStepIndex = i - 1),
					//      throw WaitDispatchRequest. TriggerBase translates to
					//      DeferredDispatchSignal → 202 Accepted.
					//   2. Re-entry (dispatchDeferred): the resume cursor logic
					//      at the top of runSteps already skipped indices < i.
					//      For the wait step itself at i = lastCompletedStepIndex
					//      + 1, treat it as satisfied and advance.
					//      Detection: existence of run.scheduledAt + wait step =
					//      we're on the second pass.
					if (stepType === "wait") {
						const waitForMs = stepAny.waitForMs as number | undefined;
						const waitUntil = stepAny.waitUntil as number | string | undefined;

						// Compute the deadline (resolves $-proxy and ISO strings).
						// Review fix-up · BUG-2. A malformed `until` string used to
						// silently fall through to `Date.now()` (immediate no-op).
						// Authors expecting "wait until tomorrow" with a typo got a
						// no-op with no warning — the worst kind of footgun. Throw
						// instead so the failure surfaces immediately, both in the
						// run trace + Studio's error surface.
						const computeDeadline = (): number => {
							if (typeof waitForMs === "number") return Date.now() + waitForMs;
							if (typeof waitUntil === "number") return waitUntil;
							if (typeof waitUntil === "string") {
								// Try parsing as a number first (ms-since-epoch as a string).
								const asNum = Number(waitUntil);
								if (!Number.isNaN(asNum)) return asNum;
								// ISO-date string.
								const t = Date.parse(waitUntil);
								if (!Number.isNaN(t)) return t;
								// Fail-fast on unparseable strings (the helpful path).
								throw new Error(
									`wait.until: cannot parse '${waitUntil}' as a number or date. Use ms-since-epoch (number or numeric string) or a valid ISO date string.`,
								);
							}
							// Schema rejects this combination, but defensive: treat
							// unsupported input as immediate so the runner doesn't
							// hang on a never-firing timer.
							return Date.now();
						};

						// Detect re-entry: on first pass the run has no
						// scheduledAt (or it's from trigger-level delay); on
						// re-entry from a wait dispatch, the run was marked
						// `delayed` with scheduledAt set to the wait deadline.
						const isReentry =
							(ctx as Record<string, unknown>)._blokDispatchReentry === true &&
							resumeFromIndex > 0 &&
							i === resumeFromIndex;

						const deadline = computeDeadline();
						const now = Date.now();

						if (isReentry || deadline <= now) {
							// Wait already satisfied (timer fired AND we're on
							// re-entry past the deadline) OR the deadline is
							// in the past (e.g., wait.for(0) or wait.until(<past>)).
							// Mark NodeRun complete and advance.
							if (tracker && nodeRunId) {
								tracker.completeNode(nodeRunId, { __waited__: true, deadline });
							}
							ctx.logger.log(`[step ${i + 1}/${steps.length}] ${step.name} (wait) → satisfied`);
							// Advance the resume cursor so a subsequent wait at a
							// later index can rely on it.
							if (tracker && traceRunId) {
								tracker.getStore().updateRun(traceRunId, { lastCompletedStepIndex: i });
							}
							continue;
						}

						// First pass: schedule + throw WaitDispatchRequest.
						// Set resume cursor BEFORE throwing so re-entry knows
						// where to pick up. Cursor = i - 1 (the last non-wait
						// step that completed).
						if (tracker && traceRunId) {
							tracker.getStore().updateRun(traceRunId, {
								lastCompletedStepIndex: i - 1,
							});
						}
						ctx.logger.log(
							`[step ${i + 1}/${steps.length}] ${step.name} (wait) → scheduled (deadline=${new Date(deadline).toISOString()})`,
						);
						throw new WaitDispatchRequest({
							scheduledAt: deadline,
							stepIndex: i,
							stepId: step.name,
							lastCompletedStepIndex: i - 1,
						});
					}

					// === Tier 1: idempotency cache lookup ===
					// Resolve the step's idempotency key against the live ctx,
					// then consult the cache. On hit, short-circuit step.process
					// entirely: replay the cached result through the same v2
					// persistence rules (ephemeral / spread / as), mark the
					// node cached for tracing, log "cached", and skip to the
					// next step. Caching layers ABOVE PersistenceHelper —
					// applyStepOutput's rules apply identically to cached and
					// freshly-computed results.
					const workflowName = (ctx as { workflow_name?: string }).workflow_name ?? "";
					const cacheStore = tracker && traceRunId ? tracker.getStore() : null;
					const resolvedIdemKey =
						cacheStore && workflowName ? resolveIdempotencyKey((step as NodeBase).idempotencyKey, ctx) : null;

					if (cacheStore && resolvedIdemKey && nodeRunId) {
						const hit = cacheStore.getIdempotencyCache(workflowName, step.name, resolvedIdemKey);
						if (hit) {
							applyStepOutput(ctx, step, { data: hit.data });
							ctx.response = hit.data as BlokResponse;
							tracker?.markNodeCached(
								nodeRunId,
								{
									sourceRunId: hit.sourceRunId,
									sourceNodeRunId: hit.sourceNodeRunId,
									cachedAt: hit.cachedAt,
								},
								hit.data,
							);
							ctx.logger.log(`${stepPrefix} → cached (from run ${hit.sourceRunId})`);
							continue;
						}
					}

					ctx.logger.log(`${stepPrefix} → started`);
					const stepStart = performance.now();

					// === Tier 1: retry loop ===
					// Wraps step.process() with capped exponential backoff per
					// `step.retry`. Default `maxAttempts: 1` preserves
					// pre-Phase-4 behaviour exactly (single attempt, no retry).
					// Soft errors (model.data.error returned from the SDK)
					// participate in retry alongside thrown errors — both flow
					// through the catch block below.
					const retryConfig = (step as NodeBase).retry;
					const maxAttempts = retryConfig ? Math.max(1, retryConfig.maxAttempts) : 1;
					// Tier 2 quick-wins — per-attempt timeout. When unset, the
					// step runs without a cap. Numeric `maxDurationMs` arrives
					// pre-parsed from `Configuration` (string `"30s"` →
					// `30000` via `parseDuration`).
					const maxDurationMs = (step as NodeBase).maxDurationMs;
					let attempt = 0;

					while (true) {
						attempt += 1;

						try {
							const processInvocation = (): Promise<{ data: unknown }> => step.process(ctx, step as unknown as Step);
							const model =
								typeof maxDurationMs === "number" && maxDurationMs > 0
									? await wrapWithTimeout(processInvocation, maxDurationMs, step.name)
									: await processInvocation();
							ctx.response = model.data as BlokResponse;

							// Treat soft errors (data carries `.error`) the same as
							// thrown errors so retry semantics are uniform.
							if (ctx.response?.error) {
								throw ctx.response.error;
							}

							// === Tier 1: idempotency cache write ===
							// Cache on the success path only — failed steps are
							// re-runnable. Honour `idempotencyKeyTTL` per step;
							// default 24h. A TTL of 0 stores an immediately-
							// expired entry (useful as a kill-switch).
							if (cacheStore && resolvedIdemKey && nodeRunId && traceRunId) {
								const ttlField = (step as NodeBase).idempotencyKeyTTL;
								const ttlMs = typeof ttlField === "number" ? ttlField : DEFAULT_IDEMPOTENCY_TTL_MS;
								const now = Date.now();
								const expiresAt = ttlMs > 0 ? now + ttlMs : now - 1;
								cacheStore.setIdempotencyCache(workflowName, step.name, resolvedIdemKey, {
									data: model.data,
									cachedAt: now,
									expiresAt,
									sourceRunId: traceRunId,
									sourceNodeRunId: nodeRunId,
								});
							}

							const stepDuration = (performance.now() - stepStart).toFixed(1);

							// --- Trace: complete node ---
							if (tracker && nodeRunId) {
								// `_stepMetrics` is stashed on ctx by RuntimeAdapterNode
								// when an adapter returns metrics (gRPC wire bytes,
								// duration, cpu, memory). Threading it through
								// `completeNode` is what gets the metrics into the
								// run store + NODE_COMPLETED event payload — Studio's
								// inspector reads them from there.
								const ctxAny = ctx as Record<string, unknown>;
								const stepMetrics = ctxAny._stepMetrics as Parameters<typeof tracker.completeNode>[2];
								ctxAny._stepMetrics = undefined;
								tracker.completeNode(nodeRunId, sanitize(ctx.response.data), stepMetrics);
								// PR 4 — advance the resume cursor after each
								// successful non-wait step. A subsequent wait step
								// reads this value to set its own cursor before
								// throwing WaitDispatchRequest. Only at top-level
								// (deep=false); nested branch flow doesn't update.
								if (!deep && traceRunId) {
									tracker.getStore().updateRun(traceRunId, { lastCompletedStepIndex: i });
								}
							}

							const attemptSuffix = attempt > 1 ? ` after ${attempt} attempts` : "";
							ctx.logger.log(`${stepPrefix} → completed (${stepDuration}ms${attemptSuffix})`);
							break;
						} catch (nodeErr) {
							// v0.5.3 — control-flow signals from a step's run()
							// must NOT be retried OR wrapped as enriched errors.
							// In the production wait path, RunnerSteps throws
							// WaitDispatchRequest from outside this retry loop, so
							// this branch is normally inert. But if a custom node
							// ever throws a wait/cancel signal from inside its
							// process()/run(), preserve the type so the outer
							// catch + TryCatchNode pass-through still recognise
							// it. Same rationale as the outer-catch instanceof
							// guards at line ~498.
							if (nodeErr instanceof WaitDispatchRequest || nodeErr instanceof RunCancelledError) {
								throw nodeErr;
							}
							if (attempt < maxAttempts && retryConfig) {
								// More attempts remain — record this as a soft
								// failure and back off before retrying. The node
								// stays in `running` status; failNode is the
								// terminal call.
								if (tracker && nodeRunId) {
									tracker.recordNodeAttemptFailed(nodeRunId, { attempt, error: nodeErr });
								}
								const backoffMs = computeBackoff(retryConfig, attempt);
								const errMsg = nodeErr instanceof Error ? nodeErr.message : String(nodeErr);
								ctx.logger.log(
									`${stepPrefix} → attempt ${attempt}/${maxAttempts} failed (${errMsg}), retrying in ${backoffMs}ms`,
								);
								await sleep(backoffMs);
								continue;
							}

							// Final attempt — fail the node and propagate the
							// enriched error so RunnerSteps' outer catch can
							// wrap it as a GlobalError.
							if (tracker && nodeRunId) {
								const existing = tracker.getNodeRun(nodeRunId);
								if (existing && existing.status === "running") {
									tracker.failNode(nodeRunId, nodeErr instanceof Error ? nodeErr : new Error(String(nodeErr)));
								}
							}
							// Tier 2 quick-wins — final-attempt timeout flips
							// the run to "timedOut" (distinct from "failed").
							// Only when the FINAL error was a StepTimeoutError;
							// mixed failures (some retries timed out, final
							// retry threw a different error) keep the normal
							// "failed" status.
							if (
								tracker &&
								traceRunId &&
								typeof maxDurationMs === "number" &&
								maxDurationMs > 0 &&
								nodeErr instanceof StepTimeoutError
							) {
								tracker.markRunTimedOut(traceRunId, {
									stepId: step.name,
									maxDurationMs,
									attemptsExhausted: attempt,
								});
							}
							const stepDuration = (performance.now() - stepStart).toFixed(1);
							const attemptSuffix = attempt > 1 ? ` after ${attempt} attempts` : "";
							ctx.logger.log(`${stepPrefix} → FAILED (${stepDuration}ms${attemptSuffix})`);

							// Enrich error with step context so developers know which step failed.
							// Attach `_blokStepId` directly on the wrap so TryCatchNode's
							// envelope construction can surface `$.error.stepId` to authors
							// without parsing the prefix back out of the message string.
							const originalMsg = nodeErr instanceof Error ? nodeErr.message : String(nodeErr);
							const enrichedError = new Error(`${stepPrefix} failed: ${originalMsg}`);
							const enrichedAny = enrichedError as Error & {
								cause?: unknown;
								_blokStepId?: string;
							};
							enrichedAny.cause = nodeErr;
							enrichedAny._blokStepId = step.name;
							throw enrichedError;
						}
					}
				} else {
					stepName = step.name;
					flow_steps = (await step.processFlow(ctx)).data as NodeBase[];

					flow = true;
					flow_step = i;

					break;
				}
			}

			if (flow) {
				const nextSteps = steps.length > flow_step + 1 ? steps.slice(flow_step + 1) : [];
				return await this.runSteps(ctx, [...flow_steps, ...nextSteps], true, stepName);
			}
		} catch (e: unknown) {
			// PR 1 follow-up · A2 fix companion. RunCancelledError carries
			// the cancellation contract end-to-end — wrapping it as
			// GlobalError would defeat TriggerBase.run's `instanceof
			// RunCancelledError` discrimination and the run would get
			// failRun'd on top of an already-cancelled status. Pass through
			// untouched so the catch in TriggerBase.run sees the right type.
			if (e instanceof RunCancelledError) {
				throw e;
			}

			// PR 4 — WaitDispatchRequest is the wait.for / wait.until
			// step's signal to TriggerBase that it should schedule a
			// deferred dispatch. Same pass-through rationale as
			// RunCancelledError — the catch in TriggerBase.run translates
			// it to DeferredDispatchSignal + 202.
			if (e instanceof WaitDispatchRequest) {
				throw e;
			}

			// Capture the step-enrichment wrap's `_blokStepId` BEFORE we
			// unwrap past it. The wrap is the outermost layer (set inside
			// the inner-try retry loop above); after unwrapping to the inner
			// GlobalError this metadata would otherwise be lost. Surfaces to
			// authors as `$.error.stepId` inside tryCatch.catch arms.
			const wrapStepId =
				typeof e === "object" && e !== null && "_blokStepId" in e
					? (e as { _blokStepId?: unknown })._blokStepId
					: undefined;

			let error_context = <Error>{};
			if (e instanceof GlobalError) {
				error_context = e as GlobalError;
			} else {
				// Walk the `.cause` chain looking for a GlobalError. The
				// step-enrichment wrap at line ~465 sets `cause = nodeErr`,
				// and `nodeErr` may itself be a GlobalError thrown from
				// `defineNode`-built nodes (e.g. `@blokjs/throw` setting
				// `code: 401` for an auth-check middleware). Without this
				// walk, the outer wrap below would force the framework's
				// generic `[step N/M] X failed: ...` message + default 500
				// code, clobbering the author's structured rejection.
				let inner: unknown = e;
				let foundGlobal: GlobalError | null = null;
				while (
					typeof inner === "object" &&
					inner !== null &&
					"cause" in inner &&
					(inner as { cause?: unknown }).cause !== undefined &&
					(inner as { cause?: unknown }).cause !== inner
				) {
					inner = (inner as { cause: unknown }).cause;
					if (inner instanceof GlobalError) {
						foundGlobal = inner;
						break;
					}
				}
				if (foundGlobal) {
					error_context = foundGlobal;
				} else {
					error_context = new GlobalError((e as Error).message);
					// Preserve the original error chain so outer handlers
					// (notably v0.5 TryCatchNode's `$.error.message` resolution)
					// can peel back through `.cause` to the author's original
					// `throw new Error("...")` text instead of the runner's
					// `[step N/M] <name> failed: ...` enriched prefix.
					(error_context as Error & { cause?: unknown }).cause = e;
				}
			}

			// Stamp the wrap's stepId on the unwrapped error so TryCatchNode's
			// `toErrorEnvelope` walk can surface it as `$.error.stepId`. The
			// inner-try wrap layer is gone by this point; this is the only
			// place where the runner can identify which sub-step failed.
			if (typeof wrapStepId === "string" && wrapStepId.length > 0) {
				(error_context as Error & { _blokStepId?: string })._blokStepId = wrapStepId;
			}

			throw error_context;
		}

		return ctx;
	}
}
