import { type BrowserScreenshotArtifact, type Context, saveBrowserScreenshot } from "@blokjs/core/runtime";
import type { Page } from "playwright";
import { z } from "zod";

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
	return saveBrowserScreenshot(ctx, await page.screenshot({ type: "png", fullPage }), name, metadata);
}

export async function withActionScreenshot<T extends object>(
	ctx: Context,
	page: Page,
	action: string,
	run: () => Promise<T>,
): Promise<T & { artifact: BrowserScreenshotArtifact }> {
	try {
		const result = await run();
		const artifact = await captureScreenshot(ctx, page, `${action}-after`, { action, phase: "after" });
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
		throw error;
	}
}
