/**
 * TryCatchNode — v0.5 primitive. JS-like try/catch/finally semantics
 * for sub-pipelines.
 *
 * The runtime config is read from `ctx.config[this.name]`:
 *   {
 *     try: NodeBase[],         // pre-resolved by Configuration's tryCatch branch
 *     catch: NodeBase[],       // pre-resolved
 *     finally?: NodeBase[],    // pre-resolved, optional
 *   }
 *
 * Execution semantics (matches JS):
 * - `try` runs first.
 * - On error: `ctx.error` is populated with `{ message, name, stack }`
 *   and `catch` runs. After catch (regardless of catch's own outcome),
 *   ctx.error is cleared.
 * - `finally` (if present) ALWAYS runs after try/catch — on normal
 *   completion, after a caught error, AND after an uncaught error
 *   from inside `catch`. Errors from `finally` propagate.
 * - Errors from `catch` (other than the one captured from `try`)
 *   propagate after `finally` runs.
 *
 * State semantics: tryCatch is a passthrough flow (like switch). All
 * blocks run on the parent ctx, so state mutations carry forward to
 * subsequent top-level steps. The step's own state slot at
 * `state[<id>]` records the final ctx.response data.
 */

import type { Context, ResponseContext } from "@blokjs/shared";
import RunnerNode from "./RunnerNode";
import { applyStepOutput } from "./workflow/PersistenceHelper";

interface TryCatchOpts {
	try?: RunnerNode[];
	catch?: RunnerNode[];
	finally?: RunnerNode[];
}

interface ErrorEnvelope {
	message: string;
	name: string;
	stack?: string;
}

function toErrorEnvelope(err: unknown): ErrorEnvelope {
	// RunnerSteps wraps step throws with a per-step prefix and again at
	// the outer catch as `GlobalError`. Both layers preserve the next-
	// level error on `.cause`. Walk the chain to bottom so author-facing
	// `$.error.message` is the original `throw new Error("kaboom")` text,
	// not the framework's `[step N/M] <name> failed: ...` enriched prefix.
	let unwrapped = err;
	while (
		typeof unwrapped === "object" &&
		unwrapped !== null &&
		"cause" in unwrapped &&
		(unwrapped as { cause?: unknown }).cause !== undefined &&
		(unwrapped as { cause?: unknown }).cause !== unwrapped
	) {
		unwrapped = (unwrapped as { cause: unknown }).cause;
	}
	if (unwrapped instanceof Error) {
		return {
			message: unwrapped.message,
			name: unwrapped.name,
			stack: unwrapped.stack,
		};
	}
	if (typeof unwrapped === "object" && unwrapped !== null) {
		const e = unwrapped as Record<string, unknown>;
		return {
			message: typeof e.message === "string" ? e.message : String(unwrapped),
			name: typeof e.name === "string" ? e.name : "Error",
			stack: typeof e.stack === "string" ? e.stack : undefined,
		};
	}
	return { message: String(unwrapped), name: "Error" };
}

export class TryCatchNode extends RunnerNode {
	async run(ctx: Context): Promise<ResponseContext> {
		this.contentType = "application/json";
		const response: ResponseContext = { success: true, data: null, error: null };

		const opts = ((ctx.config as Record<string, unknown> | undefined)?.[this.name] ?? {}) as TryCatchOpts;
		const tryBlock = Array.isArray(opts.try) ? opts.try : [];
		const catchBlock = Array.isArray(opts.catch) ? opts.catch : [];
		const finallyBlock = Array.isArray(opts.finally) ? opts.finally : undefined;

		// Lazy import — circular-dep guard (Runner pulls in Configuration).
		const { default: Runner } = await import("./Runner");

		// Snapshot prior ctx.error so nested tryCatch / outer error state
		// restores cleanly even if we don't enter `catch` (e.g. nested
		// tryCatch where the outer is currently in its own catch arm).
		const ctxAny = ctx as unknown as Record<string, unknown>;
		const priorError = ctxAny.error;

		let caught: ErrorEnvelope | null = null;
		let pendingError: unknown = null; // an error from `catch` that needs to propagate after `finally`

		try {
			if (tryBlock.length > 0) {
				const tryRunner = new Runner(tryBlock);
				// `deep: true` so the inner runSteps doesn't inherit the
				// outer run's `lastCompletedStepIndex` cursor (PR 4 wait/
				// resume logic) and skip every nested step.
				await tryRunner.run(ctx, { deep: true, stepName: this.name });
			}
		} catch (err) {
			caught = toErrorEnvelope(err);
			// Make `$.error.message` etc. resolvable by the blueprint mapper
			// inside the catch block. Mapper reads ctx.error directly.
			ctxAny.error = caught;
			try {
				if (catchBlock.length > 0) {
					const catchRunner = new Runner(catchBlock);
					await catchRunner.run(ctx, { deep: true, stepName: this.name });
				}
			} catch (catchErr) {
				// `catch` itself threw. Hold onto it so `finally` still runs,
				// then propagate after.
				pendingError = catchErr;
			}
		}

		// `finally` always runs — success, caught error, or uncaught from catch.
		// Errors from `finally` propagate IMMEDIATELY (overrides any
		// pendingError, matching JS semantics where a finally throw
		// supersedes a catch throw).
		if (finallyBlock && finallyBlock.length > 0) {
			// Restore ctx.error to its state outside this tryCatch — finally
			// runs without `$.error` (matches JS scoping: finally doesn't see
			// the bound exception variable, and catch's variable is out of
			// scope).
			ctxAny.error = priorError;
			const finallyRunner = new Runner(finallyBlock);
			await finallyRunner.run(ctx, { deep: true, stepName: this.name });
		} else {
			ctxAny.error = priorError;
		}

		if (pendingError !== null) {
			// Re-throw catch's error after finally completed.
			throw pendingError;
		}

		// State + response: tryCatch step's data is the final ctx.response
		// (whatever the last block left there). Persist via applyStepOutput.
		const data = ctx.response;
		response.data = data;
		applyStepOutput(ctx, this, { data });
		return response;
	}
}
