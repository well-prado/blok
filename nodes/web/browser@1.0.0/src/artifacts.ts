import { type BrowserScreenshotArtifact, type Context, RunTracker, saveBrowserScreenshot } from "@blokjs/core/runtime";
import type { Page } from "playwright";
import { z } from "zod";
import type { BrowserHandle } from "./BrowserSessionManager";
import { sanitizeUrl } from "./locator";

export const browserArtifactSchema = z.object({
	id: z.string(),
	runId: z.string(),
	nodeRunId: z.string().optional(),
	kind: z.literal("screenshot"),
	name: z.string(),
	mimeType: z.literal("image/png"),
	size: z.number().int().nonnegative(),
	createdAt: z.number().int(),
	url: z.string(),
	metadata: z.record(z.unknown()).optional(),
});

export async function captureScreenshot(
	ctx: Context,
	page: Page,
	name: string,
	metadata?: Record<string, unknown>,
	fullPage = false,
): Promise<BrowserScreenshotArtifact> {
	const artifact = await saveBrowserScreenshot(ctx, await page.screenshot({ type: "png", fullPage }), name, metadata);
	const privateCtx = ctx as unknown as Record<string, unknown>;
	const runId = privateCtx._traceRunId as string | undefined;
	if (runId) {
		RunTracker.getInstance().recordBrowserEvent(
			runId,
			"BROWSER_ARTIFACT",
			{ artifact },
			privateCtx._traceNodeId as string | undefined,
		);
	}
	return artifact;
}

export async function withActionScreenshot<T extends object>(
	ctx: Context,
	page: Page,
	action: string,
	session: BrowserHandle,
	run: () => Promise<T>,
): Promise<T & { artifact: BrowserScreenshotArtifact }> {
	const privateCtx = ctx as unknown as Record<string, unknown>;
	const runId = privateCtx._traceRunId as string | undefined;
	const nodeRunId = privateCtx._traceNodeId as string | undefined;
	const tracker = RunTracker.getInstance();
	if (runId) {
		tracker.recordBrowserEvent(
			runId,
			"BROWSER_ACTION",
			{
				action,
				phase: "running",
				...session,
				url: sanitizeUrl(page.url()),
			},
			nodeRunId,
		);
	}
	try {
		const result = await run();
		const artifact = await captureScreenshot(ctx, page, `${action}-after`, { action, phase: "after" });
		if (runId) {
			tracker.recordBrowserEvent(
				runId,
				"BROWSER_ACTION",
				{
					action,
					phase: "completed",
					...session,
					url: sanitizeUrl(page.url()),
					...browserActionOverlay(result),
				},
				nodeRunId,
			);
			tracker.recordBrowserEvent(
				runId,
				"BROWSER_PAGE_UPDATED",
				{
					...session,
					url: sanitizeUrl(page.url()),
				},
				nodeRunId,
			);
		}
		return { ...result, artifact };
	} catch (error) {
		try {
			await captureScreenshot(ctx, page, `${action}-failure`, { action, phase: "failure" });
		} catch (captureError) {
			ctx.logger.logLevel(
				"warn",
				`[blok][browser] failure screenshot failed: ${captureError instanceof Error ? captureError.message : String(captureError)}`,
			);
		}
		if (runId) {
			tracker.recordBrowserEvent(
				runId,
				"BROWSER_ACTION",
				{
					action,
					phase: "failed",
					...session,
					url: sanitizeUrl(page.url()),
					error: error instanceof Error ? error.message : String(error),
				},
				nodeRunId,
			);
		}
		throw error;
	}
}

function browserActionOverlay(result: object): Record<string, unknown> {
	const value = result as { locator?: unknown; box?: unknown; masked?: unknown };
	return {
		...(value.locator && typeof value.locator === "object" ? { locator: value.locator } : {}),
		...(value.box && typeof value.box === "object" ? { box: value.box } : {}),
		...(typeof value.masked === "boolean" ? { masked: value.masked } : {}),
	};
}
