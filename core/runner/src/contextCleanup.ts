import type { Context } from "@blokjs/shared";

export type ContextCleanup = () => void | Promise<void>;

type PrivateContext = {
	cleanups?: Set<ContextCleanup>;
};

const shutdownCleanups = new Set<ContextCleanup>();

function privateContext(ctx: Context): PrivateContext {
	if (!ctx._PRIVATE_ || typeof ctx._PRIVATE_ !== "object") ctx._PRIVATE_ = {};
	return ctx._PRIVATE_ as PrivateContext;
}

/** Register work that must finish when this workflow context becomes terminal. */
export function registerContextCleanup(ctx: Context, cleanup: ContextCleanup): () => void {
	const privateSlot = privateContext(ctx);
	const cleanups = privateSlot.cleanups ?? new Set<ContextCleanup>();
	privateSlot.cleanups = cleanups;
	cleanups.add(cleanup);
	return () => cleanups.delete(cleanup);
}

/** Run every cleanup once. Failures are logged and never mask the workflow result. */
export async function runContextCleanups(ctx: Context): Promise<void> {
	const cleanups = privateContext(ctx).cleanups;
	if (!cleanups?.size) return;
	privateContext(ctx).cleanups = new Set();

	for (const cleanup of cleanups) {
		try {
			await cleanup();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			try {
				ctx.logger?.logLevel("warn", `[blok][cleanup] ${message}`);
			} catch {
				console.error(`[blok][cleanup] ${message}`);
			}
		}
	}
}

/** Register a process resource cleanup for TriggerBase's graceful shutdown. */
export function registerShutdownCleanup(cleanup: ContextCleanup): () => void {
	shutdownCleanups.add(cleanup);
	return () => shutdownCleanups.delete(cleanup);
}

export async function runShutdownCleanups(): Promise<void> {
	for (const cleanup of shutdownCleanups) {
		try {
			await cleanup();
		} catch (error) {
			console.error(`[blok][shutdown] cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
