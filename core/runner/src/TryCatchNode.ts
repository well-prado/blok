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
import { GlobalError } from "@blokjs/shared";
import { RunCancelledError } from "./RunCancelledError";
import RunnerNode from "./RunnerNode";
import { WaitDispatchRequest } from "./WaitDispatchRequest";
import { applyStepOutput } from "./workflow/PersistenceHelper";

interface TryCatchOpts {
	try?: RunnerNode[];
	catch?: RunnerNode[];
	finally?: RunnerNode[];
}

interface ErrorEnvelope {
	/** The original (unwrapped) error message. */
	message: string;
	/** Error class name — e.g. "Error", "UnauthorizedError", "ZodError". */
	name: string;
	/** Stack trace string when present on the error. */
	stack?: string;
	/**
	 * HTTP-style status code carried by `GlobalError` (set via
	 * `@blokjs/throw` inputs.code, or by ZodError → 400 mapping in
	 * `defineNode.mapErrorToGlobalError`). Surfaces as `$.error.code` so
	 * a catch arm can re-throw with the same status, branch on it
	 * (4xx vs 5xx), or include it in an audit-log payload.
	 */
	code?: number;
	/**
	 * The id of the try-arm step that threw, extracted from the wrap
	 * `RunnerSteps` attaches at line ~465. Surfaces as `$.error.stepId`
	 * so a catch arm can route by failure point ("payment failed → notify
	 * billing", "inventory failed → notify warehouse") without having to
	 * regex the framework-decorated message.
	 */
	stepId?: string;
}

function toErrorEnvelope(err: unknown): ErrorEnvelope {
	// RunnerSteps wraps step throws with a per-step prefix and again at
	// the outer catch as `GlobalError`. Both layers preserve the next-
	// level error on `.cause`. Walk the chain to bottom so author-facing
	// `$.error.message` is the original `throw new Error("kaboom")` text,
	// not the framework's `[step N/M] <name> failed: ...` enriched prefix.
	//
	// While walking, harvest two cross-layer fields:
	//   - `code`  — only carried by GlobalError (the framework's typed
	//     error class). The first GlobalError encountered wins; this lets
	//     `@blokjs/throw` inputs.code propagate to the catch arm even if
	//     RunnerSteps re-wraps the throw in a generic Error.
	//   - `stepId` — set by RunnerSteps' enrichment as `_blokStepId` on
	//     the wrap layer. The wrap is the OUTER error, so we capture it
	//     before unwrapping past it.
	let unwrapped: unknown = err;
	let code: number | undefined;
	let stepId: string | undefined;

	const captureMeta = (candidate: unknown): void => {
		if (typeof candidate !== "object" || candidate === null) return;
		const c = candidate as { _blokStepId?: unknown };
		if (stepId === undefined && typeof c._blokStepId === "string") {
			stepId = c._blokStepId;
		}
		if (code === undefined && candidate instanceof GlobalError) {
			// GlobalError stores HTTP status on `context.code`, not directly
			// on the error instance — see GlobalError.setCode() at
			// core/shared/src/GlobalError.ts:14.
			const ctxCode = candidate.context?.code;
			if (typeof ctxCode === "number") code = ctxCode;
		}
	};

	captureMeta(unwrapped);
	while (
		typeof unwrapped === "object" &&
		unwrapped !== null &&
		"cause" in unwrapped &&
		(unwrapped as { cause?: unknown }).cause !== undefined &&
		(unwrapped as { cause?: unknown }).cause !== unwrapped
	) {
		unwrapped = (unwrapped as { cause: unknown }).cause;
		captureMeta(unwrapped);
	}

	const meta = { ...(code !== undefined ? { code } : {}), ...(stepId !== undefined ? { stepId } : {}) };

	if (unwrapped instanceof Error) {
		return {
			message: unwrapped.message,
			name: unwrapped.name,
			stack: unwrapped.stack,
			...meta,
		};
	}
	if (typeof unwrapped === "object" && unwrapped !== null) {
		const e = unwrapped as Record<string, unknown>;
		return {
			message: typeof e.message === "string" ? e.message : String(unwrapped),
			name: typeof e.name === "string" ? e.name : "Error",
			stack: typeof e.stack === "string" ? e.stack : undefined,
			...meta,
		};
	}
	return { message: String(unwrapped), name: "Error", ...meta };
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
			// v0.5.3 — Phase 1 of wait-inside-primitives. Two control-flow
			// signals masquerade as Error subclasses but MUST NOT be caught
			// by the application-level catch arm:
			//
			//   - WaitDispatchRequest: the runner's "defer this run" signal
			//     thrown by `wait.for` / `wait.until` steps. Treating it as
			//     a caught exception would fire the catch arm + finally and
			//     return success — the wait would silently no-op and the
			//     downstream effect (chargeback timeout, payment delay,
			//     audit window) would never happen.
			//
			//   - RunCancelledError: the cooperative-cancellation signal
			//     fired by `POST /__blok/runs/:id/cancel`. Treating it as a
			//     caught exception would let the run continue past
			//     cancellation, defeating the whole contract.
			//
			// Re-throw past finally — the wait/cancel hasn't COMPLETED, and
			// finally semantically fires on completion. On wait re-entry the
			// whole tryCatch step re-executes from the top (Phase 1 limit:
			// no mid-arm resume), so finally fires when that re-run reaches
			// terminal state.
			//
			// IMPORTANT — Phase 1 author contract: every step in a `try`
			// arm that contains a wait MUST be idempotent. The first pass
			// runs steps 1..N-1, defers at the wait, and the resumed run
			// re-runs steps 1..N-1 from scratch before hitting the wait's
			// re-entry detection. Use `idempotencyKey` on each pre-wait
			// step (or rely on natural idempotency — read-only fetches,
			// stateless transforms) to make re-execution free.
			if (err instanceof WaitDispatchRequest || err instanceof RunCancelledError) {
				throw err;
			}
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
				// Same pass-through contract for waits / cancellations
				// thrown from inside the catch arm. (Phase 1 doesn't
				// formally support waits in catch arms — re-entry semantics
				// differ from the try-arm path — but at least don't lose
				// the signal here. Document as a Phase 4 follow-up.)
				if (catchErr instanceof WaitDispatchRequest || catchErr instanceof RunCancelledError) {
					throw catchErr;
				}
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
