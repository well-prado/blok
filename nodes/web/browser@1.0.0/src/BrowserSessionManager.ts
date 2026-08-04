import { randomUUID } from "node:crypto";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright";

export type BrowserHandle = {
	sessionId: string;
	pageId: string;
};

export type BrowserSessionRecord = {
	sessionId: string;
	runId: string;
	browser: Browser;
	context: BrowserContext;
	pages: Map<string, Page>;
	createdAt: number;
	lastActivityAt: number;
	status: "live" | "closing" | "closed";
	removeAbortListener?: () => void;
};

type Options = {
	maxSessions?: number;
	idleTtlMs?: number;
	launchBrowser?: () => Promise<Browser>;
};

const positiveInteger = (value: string | undefined, fallback: number): number => {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export class BrowserSessionManager {
	private readonly sessions = new Map<string, BrowserSessionRecord>();
	private readonly launchingRuns = new Set<string>();
	private readonly maxSessions: number;
	private readonly idleTtlMs: number;
	private readonly launchBrowser: () => Promise<Browser>;
	private reaper?: ReturnType<typeof setInterval>;

	constructor(options: Options = {}) {
		this.maxSessions = options.maxSessions ?? 4;
		this.idleTtlMs = options.idleTtlMs ?? 300_000;
		this.launchBrowser = options.launchBrowser ?? (() => chromium.launch());
		if (this.maxSessions < 1 || this.idleTtlMs < 1) throw new Error("Browser session limits must be positive");
	}

	get activeSessionCount(): number {
		return this.sessions.size;
	}

	async launch(runId: string, signal?: AbortSignal): Promise<BrowserHandle> {
		if (!runId) throw new Error("Browser session requires a run id");
		signal?.throwIfAborted();
		if (this.launchingRuns.has(runId) || [...this.sessions.values()].some((session) => session.runId === runId)) {
			throw new Error("This run already owns a browser session");
		}
		if (this.sessions.size + this.launchingRuns.size >= this.maxSessions) {
			throw new Error(`Browser session limit reached (${this.maxSessions})`);
		}

		this.launchingRuns.add(runId);
		let browser: Browser | undefined;
		let context: BrowserContext | undefined;
		try {
			browser = await this.launchBrowser();
			signal?.throwIfAborted();
			context = await browser.newContext();
			signal?.throwIfAborted();
			const page = await context.newPage();
			signal?.throwIfAborted();

			const now = Date.now();
			const sessionId = `bs_${randomUUID()}`;
			const pageId = `bp_${randomUUID()}`;
			const record: BrowserSessionRecord = {
				sessionId,
				runId,
				browser,
				context,
				pages: new Map([[pageId, page]]),
				createdAt: now,
				lastActivityAt: now,
				status: "live",
			};

			if (signal) {
				const abort = () => {
					void this.closeRecord(record).catch((error) => {
						console.error(
							`[blok][browser] abort cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
						);
					});
				};
				signal.addEventListener("abort", abort, { once: true });
				record.removeAbortListener = () => signal.removeEventListener("abort", abort);
			}

			this.sessions.set(sessionId, record);
			this.startReaper();
			return { sessionId, pageId };
		} catch (error) {
			await context?.close().catch(() => undefined);
			await browser?.close().catch(() => undefined);
			throw error;
		} finally {
			this.launchingRuns.delete(runId);
		}
	}

	getPage(runId: string, handle: BrowserHandle, signal?: AbortSignal): Page {
		signal?.throwIfAborted();
		const record = this.ownedSession(runId, handle.sessionId);
		const page = record.pages.get(handle.pageId);
		if (!page) throw new Error("Browser page handle is invalid or closed");
		record.lastActivityAt = Date.now();
		return page;
	}

	async close(runId: string, sessionId: string): Promise<void> {
		await this.closeRecord(this.ownedSession(runId, sessionId));
	}

	async closeRun(runId: string): Promise<void> {
		await Promise.all(
			[...this.sessions.values()]
				.filter((session) => session.runId === runId)
				.map((session) => this.closeRecord(session)),
		);
	}

	async closeAll(): Promise<void> {
		await Promise.all([...this.sessions.values()].map((session) => this.closeRecord(session)));
	}

	async sweepExpired(now = Date.now()): Promise<void> {
		await Promise.all(
			[...this.sessions.values()]
				.filter((session) => now - session.lastActivityAt >= this.idleTtlMs)
				.map((session) => this.closeRecord(session)),
		);
	}

	private ownedSession(runId: string, sessionId: string): BrowserSessionRecord {
		const record = this.sessions.get(sessionId);
		if (!record || record.status !== "live") throw new Error("Browser session handle is invalid or closed");
		if (record.runId !== runId) throw new Error("Browser session belongs to another run");
		return record;
	}

	private async closeRecord(record: BrowserSessionRecord): Promise<void> {
		if (record.status !== "live") return;
		record.status = "closing";
		record.removeAbortListener?.();
		this.sessions.delete(record.sessionId);

		let firstError: unknown;
		try {
			await record.context.close();
		} catch (error) {
			firstError = error;
		}
		try {
			await record.browser.close();
		} catch (error) {
			firstError ??= error;
		}
		record.pages.clear();
		record.status = "closed";
		this.stopReaperIfIdle();
		if (firstError) throw firstError;
	}

	private startReaper(): void {
		if (this.reaper) return;
		this.reaper = setInterval(() => void this.sweepExpired(), Math.max(1_000, Math.min(this.idleTtlMs, 30_000)));
		this.reaper.unref?.();
	}

	private stopReaperIfIdle(): void {
		if (this.sessions.size || !this.reaper) return;
		clearInterval(this.reaper);
		this.reaper = undefined;
	}
}

export const browserSessionManager = new BrowserSessionManager({
	maxSessions: positiveInteger(process.env.BLOK_BROWSER_MAX_SESSIONS, 4),
	idleTtlMs: positiveInteger(process.env.BLOK_BROWSER_IDLE_TTL_MS, 300_000),
});
