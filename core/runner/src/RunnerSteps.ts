import { type Context, GlobalError, type NodeBase, type Step } from "@blokjs/shared";
import type BlokResponse from "./BlokResponse";
import { RunTracker } from "./tracing/RunTracker";
import { sanitize } from "./tracing/sanitize";

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
						const nodeRun = tracker.startNode(traceRunId, {
							nodeName: step.name,
							nodeType: stepType,
							runtimeKind: stepAny.runtime as string | undefined,
							inputs: sanitize(configAny?.[step.name]?.inputs ?? stepAny.config),
							depth: depthLevel,
							stepIndex: i,
						});
						nodeRunId = nodeRun.id;
						(ctx as Record<string, unknown>)._traceNodeId = nodeRunId;
					}

					ctx.logger.log(`${stepPrefix} → started`);
					const stepStart = performance.now();

					try {
						const model = await step.process(ctx, step as unknown as Step);
						ctx.response = model.data as BlokResponse;

						const stepDuration = (performance.now() - stepStart).toFixed(1);

						// --- Trace: complete or fail node ---
						if (tracker && nodeRunId) {
							if (ctx.response.error) {
								// Pass the error VERBATIM so RunTracker's
								// `toRunErrorDetail` can preserve BlokError
								// fields (category, retryable, remediation,
								// causes, …) when the SDK supplied a typed
								// failure. Strings and bare Errors fall
								// through to the legacy `{message, stack}`
								// shape.
								tracker.failNode(nodeRunId, ctx.response.error);
							} else {
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
						}

						if (ctx.response.error) {
							ctx.logger.log(`${stepPrefix} → FAILED (${stepDuration}ms)`);
							throw ctx.response.error;
						}

						ctx.logger.log(`${stepPrefix} → completed (${stepDuration}ms)`);
					} catch (nodeErr) {
						// --- Trace: fail node on exception ---
						if (tracker && nodeRunId) {
							const existing = tracker.getNodeRun(nodeRunId);
							if (existing && existing.status === "running") {
								tracker.failNode(nodeRunId, nodeErr instanceof Error ? nodeErr : new Error(String(nodeErr)));
							}
						}

						// Enrich error with step context so developers know which step failed
						const originalMsg = nodeErr instanceof Error ? nodeErr.message : String(nodeErr);
						const enrichedError = new Error(`${stepPrefix} failed: ${originalMsg}`);
						(enrichedError as Error & { cause?: unknown }).cause = nodeErr;
						throw enrichedError;
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
