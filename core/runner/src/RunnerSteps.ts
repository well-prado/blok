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
					if (tracker && traceRunId) {
						const stepAny = step as unknown as Record<string, unknown>;
						const configAny = ctx.config as unknown as Record<string, Record<string, unknown>>;
						const nodeRun = tracker.startNode(traceRunId, {
							nodeName: step.name,
							nodeType: (stepAny.type as string) || "unknown",
							runtimeKind: stepAny.runtime as string | undefined,
							inputs: sanitize(configAny?.[step.name]?.inputs ?? stepAny.config),
							depth: depthLevel,
							stepIndex: i,
						});
						nodeRunId = nodeRun.id;
						(ctx as Record<string, unknown>)._traceNodeId = nodeRunId;
					}

					try {
						const model = await step.process(ctx, step as unknown as Step);
						ctx.response = model.data as BlokResponse;

						// --- Trace: complete or fail node ---
						if (tracker && nodeRunId) {
							if (ctx.response.error) {
								const errMsg =
									typeof ctx.response.error === "string"
										? ctx.response.error
										: (ctx.response.error as Error).message || "Node error";
								tracker.failNode(nodeRunId, new Error(errMsg));
							} else {
								tracker.completeNode(nodeRunId, sanitize(ctx.response.data));
							}
						}

						if (ctx.response.error) throw ctx.response.error;
					} catch (nodeErr) {
						// --- Trace: fail node on exception ---
						if (tracker && nodeRunId) {
							const existing = tracker.getNodeRun(nodeRunId);
							if (existing && existing.status === "running") {
								tracker.failNode(nodeRunId, nodeErr instanceof Error ? nodeErr : new Error(String(nodeErr)));
							}
						}
						throw nodeErr;
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
