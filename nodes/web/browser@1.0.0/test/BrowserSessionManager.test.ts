import type { Browser, BrowserContext, Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { BrowserSessionManager } from "../src/BrowserSessionManager";

function fakeBrowser(options: { pageError?: Error; contextCloseError?: Error } = {}) {
	const page = {} as Page;
	const context = {
		newPage: options.pageError ? vi.fn().mockRejectedValue(options.pageError) : vi.fn().mockResolvedValue(page),
		close: options.contextCloseError
			? vi.fn().mockRejectedValue(options.contextCloseError)
			: vi.fn().mockResolvedValue(undefined),
	} as unknown as BrowserContext;
	const browser = {
		newContext: vi.fn().mockResolvedValue(context),
		close: vi.fn().mockResolvedValue(undefined),
	} as unknown as Browser;
	return { browser, context, page };
}

describe("BrowserSessionManager", () => {
	it("isolates opaque one-page sessions between concurrent runs", async () => {
		const first = fakeBrowser();
		const second = fakeBrowser();
		const launchBrowser = vi.fn().mockResolvedValueOnce(first.browser).mockResolvedValueOnce(second.browser);
		const manager = new BrowserSessionManager({ maxSessions: 2, launchBrowser });

		const [a, b] = await Promise.all([manager.launch("run-a"), manager.launch("run-b")]);

		expect(a.sessionId).not.toBe(b.sessionId);
		expect(a.pageId).not.toBe(b.pageId);
		expect(manager.getPage("run-a", a)).toBe(first.page);
		expect(manager.getPage("run-b", b)).toBe(second.page);
		expect(() => manager.getPage("run-b", a)).toThrow("another run");
		await manager.closeAll();
	});

	it("enforces one session per run and the process limit while launches overlap", async () => {
		let release: ((browser: Browser) => void) | undefined;
		const pending = new Promise<Browser>((resolve) => {
			release = resolve;
		});
		const manager = new BrowserSessionManager({ maxSessions: 1, launchBrowser: () => pending });
		const launch = manager.launch("run-a");

		await expect(manager.launch("run-a")).rejects.toThrow("already owns");
		await expect(manager.launch("run-b")).rejects.toThrow("limit reached");
		const fake = fakeBrowser();
		release?.(fake.browser);
		await launch;
		await manager.closeAll();
	});

	it("closes on abort and rejects closed handles", async () => {
		const fake = fakeBrowser();
		const manager = new BrowserSessionManager({ launchBrowser: async () => fake.browser });
		const controller = new AbortController();
		const handle = await manager.launch("run-a", controller.signal);

		controller.abort();
		await vi.waitFor(() => expect(manager.activeSessionCount).toBe(0));
		expect(fake.context.close).toHaveBeenCalledOnce();
		expect(() => manager.getPage("run-a", handle)).toThrow("invalid or closed");
	});

	it("expires idle debug sessions", async () => {
		const fake = fakeBrowser();
		const manager = new BrowserSessionManager({ idleTtlMs: 10, launchBrowser: async () => fake.browser });
		await manager.launch("run-a");

		await manager.sweepExpired(Date.now() + 11);

		expect(manager.activeSessionCount).toBe(0);
		expect(fake.browser.close).toHaveBeenCalledOnce();
	});

	it("cleans partial launches and still closes the browser when context cleanup throws", async () => {
		const pageFailure = fakeBrowser({ pageError: new Error("page failed") });
		const manager = new BrowserSessionManager({ launchBrowser: async () => pageFailure.browser });
		await expect(manager.launch("run-a")).rejects.toThrow("page failed");
		expect(pageFailure.context.close).toHaveBeenCalledOnce();
		expect(pageFailure.browser.close).toHaveBeenCalledOnce();

		const cleanupFailure = fakeBrowser({ contextCloseError: new Error("context close failed") });
		const secondManager = new BrowserSessionManager({ launchBrowser: async () => cleanupFailure.browser });
		const handle = await secondManager.launch("run-b");
		await expect(secondManager.close("run-b", handle.sessionId)).rejects.toThrow("context close failed");
		expect(cleanupFailure.browser.close).toHaveBeenCalledOnce();
	});
});
