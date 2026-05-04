import { type Context, GlobalError, type NodeBase, type Step } from "@blokjs/shared";
import type BlokResponse from "./BlokResponse";
import { RunCancelledError } from "./RunCancelledError";
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

			for (let i = 0; i < steps.length; i++) {
				const step: NodeBase = steps[i];

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
						const nodeRun = tracker.startNode(traceRunId, {
							nodeName: step.name,
							nodeType: stepType,
							runtimeKind: stepAny.runtime as string | undefined,
							inputs: sanitize(configAny?.[step.name]?.inputs ?? stepAny.config),
							depth: depthLevel,
							stepIndex: i,
							wait: subworkflowWait,
						});
						nodeRunId = nodeRun.id;
						(ctx as Record<string, unknown>)._traceNodeId = nodeRunId;
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
							}

							const attemptSuffix = attempt > 1 ? ` after ${attempt} attempts` : "";
							ctx.logger.log(`${stepPrefix} → completed (${stepDuration}ms${attemptSuffix})`);
							break;
						} catch (nodeErr) {
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

							// Enrich error with step context so developers know which step failed
							const originalMsg = nodeErr instanceof Error ? nodeErr.message : String(nodeErr);
							const enrichedError = new Error(`${stepPrefix} failed: ${originalMsg}`);
							(enrichedError as Error & { cause?: unknown }).cause = nodeErr;
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
			let error_context = <Error>{};
			if (e instanceof GlobalError) {
				error_context = e as GlobalError;
			} else {
				error_context = new GlobalError((e as Error).message);
			}

			throw error_context;
		}

		return ctx;
	}
}
