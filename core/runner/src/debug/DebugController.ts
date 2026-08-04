import type { Context, NodeBase } from "@blokjs/shared";
import type { BeforeStepHook } from "../RunnerSteps";
import { RunTracker } from "../tracing/RunTracker";

export type DebugAction = "continue" | "step" | "stop";

interface DebugSession {
	breakpoints: Set<string>;
	firstStep: boolean;
	pauseNext: boolean;
	runId?: string;
	release?: () => void;
	abortCleanup?: () => void;
	timer?: ReturnType<typeof setTimeout>;
}

export interface DebugSessionHandle {
	beforeStep: BeforeStepHook;
	dispose: () => void;
}

export interface DebugControlResult {
	ok: boolean;
	status?: "running" | "cancelled";
	reason?: "not-debugging" | "not-paused" | "not-cancellable";
}

const DEFAULT_PAUSE_TTL_MS = 15 * 60 * 1000;

/** Process-local controller for Studio's opt-in step debugger. */
export class DebugController {
	private static instance: DebugController | null = null;
	private readonly sessions = new Map<string, DebugSession>();

	static getInstance(): DebugController {
		if (!DebugController.instance) DebugController.instance = new DebugController();
		return DebugController.instance;
	}

	static resetInstance(): void {
		DebugController.instance?.disposeAll();
		DebugController.instance = null;
	}

	attach(breakpoints: string[]): DebugSessionHandle {
		const session: DebugSession = {
			breakpoints: new Set(breakpoints),
			firstStep: true,
			pauseNext: false,
		};
		return {
			beforeStep: (ctx, step, index, total, deep) => this.beforeStep(session, ctx, step, index, total, deep),
			dispose: () => this.dispose(session),
		};
	}

	control(runId: string, action: DebugAction): DebugControlResult {
		const session = this.sessions.get(runId);
		if (!session) return { ok: false, reason: "not-debugging" };
		if (!session.release) return { ok: false, reason: "not-paused" };

		this.clearTimer(session);
		if (action === "stop") {
			const cancelled = RunTracker.getInstance().abortRunningRun(runId);
			this.release(session);
			return cancelled ? { ok: true, status: "cancelled" } : { ok: false, reason: "not-cancellable" };
		}

		session.pauseNext = action === "step";
		RunTracker.getInstance().resumeRun(runId, { action });
		this.release(session);
		return { ok: true, status: "running" };
	}

	private async beforeStep(
		session: DebugSession,
		ctx: Context,
		step: NodeBase,
		index: number,
		total: number,
		deep: boolean,
	): Promise<void> {
		const runId = (ctx as Context & { _traceRunId?: string })._traceRunId;
		if (!runId) return;
		if (!session.runId) {
			session.runId = runId;
			this.sessions.set(runId, session);
		}

		const shouldPause = session.firstStep || session.pauseNext || session.breakpoints.has(step.name);
		session.firstStep = false;
		session.pauseNext = false;
		if (!shouldPause) return;

		const paused = RunTracker.getInstance().pauseRun(runId, {
			stepId: step.name,
			index,
			total,
			deep,
		});
		if (!paused) return;
		await new Promise<void>((resolve) => {
			session.release = resolve;
			const onAbort = () => this.release(session);
			ctx.signal?.addEventListener("abort", onAbort, { once: true });
			session.abortCleanup = () => ctx.signal?.removeEventListener("abort", onAbort);
			const configuredTtl = Number(process.env.BLOK_DEBUG_PAUSE_TTL_MS);
			const ttl = Number.isFinite(configuredTtl) && configuredTtl > 0 ? configuredTtl : DEFAULT_PAUSE_TTL_MS;
			session.timer = setTimeout(() => {
				RunTracker.getInstance().abortRunningRun(runId);
				this.release(session);
			}, ttl);
			session.timer.unref?.();
			if (ctx.signal?.aborted) this.release(session);
		});
	}

	private release(session: DebugSession): void {
		const release = session.release;
		session.release = undefined;
		session.abortCleanup?.();
		session.abortCleanup = undefined;
		release?.();
	}

	private clearTimer(session: DebugSession): void {
		if (session.timer) clearTimeout(session.timer);
		session.timer = undefined;
	}

	private dispose(session: DebugSession): void {
		this.clearTimer(session);
		this.release(session);
		if (session.runId) this.sessions.delete(session.runId);
	}

	private disposeAll(): void {
		for (const session of this.sessions.values()) this.dispose(session);
		this.sessions.clear();
	}
}
