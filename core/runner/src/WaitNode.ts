/**
 * Stub node for `wait.for(duration)` / `wait.until(date)` steps.
 *
 * Wait steps are intercepted by `RunnerSteps` BEFORE `step.process` is
 * invoked — the runner reads `waitForMs` / `waitUntil` off the step
 * descriptor, throws `WaitDispatchRequest` on the first pass to defer
 * the run, and skips the step entirely on resume. So this node's
 * `run()` should never actually fire in the happy path.
 *
 * It exists only so `Configuration.nodeTypes()` has a `wait` resolver
 * to satisfy `getSteps()` at workflow load time. Without a resolver,
 * loading any workflow that contains a wait step throws `Node type
 * wait not found` at boot.
 */

import type { Context, ResponseContext } from "@blokjs/shared";
import RunnerNode from "./RunnerNode";

export class WaitNode extends RunnerNode {
	/** Parsed milliseconds for `wait.for` (set by WorkflowNormalizer). */
	public declare waitForMs?: number;
	/** Raw `wait.until` value (number ms or string ISO date / $-proxy expression). */
	public declare waitUntil?: number | string;

	async run(_ctx: Context): Promise<ResponseContext> {
		// Defensive no-op. Hit only if `RunnerSteps` somehow falls through
		// to step.process() on a wait step (shouldn't happen — the
		// `stepType === "wait"` branch in RunnerSteps intercepts and
		// either resolves immediately for past/zero waits or throws
		// `WaitDispatchRequest` to defer).
		return { success: true, data: null, error: null };
	}
}
