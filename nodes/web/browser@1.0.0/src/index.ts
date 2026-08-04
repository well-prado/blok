import { defineNode } from "@blokjs/core";
import { registerContextCleanup, registerShutdownCleanup } from "@blokjs/runner/contextCleanup";
import { z } from "zod";
import { browserSessionManager } from "./BrowserSessionManager";

const handleSchema = z.object({
	sessionId: z.string().min(1),
	pageId: z.string().min(1),
});

export const BrowserLaunchNode = defineNode({
	name: "@blokjs/browser-launch",
	description: "Launches an isolated Chromium session with one page",
	input: z.object({}),
	output: handleSchema,
	async execute(ctx) {
		const handle = await browserSessionManager.launch(ctx.id, ctx.signal);
		registerContextCleanup(ctx, () => browserSessionManager.closeRun(ctx.id));
		return handle;
	},
});

export const BrowserCloseNode = defineNode({
	name: "@blokjs/browser-close",
	description: "Closes the Chromium session owned by this workflow run",
	input: handleSchema.pick({ sessionId: true }),
	output: z.object({ closed: z.literal(true) }),
	async execute(ctx, input) {
		await browserSessionManager.close(ctx.id, input.sessionId);
		return { closed: true as const };
	},
});

registerShutdownCleanup(() => browserSessionManager.closeAll());

export { BrowserSessionManager, browserSessionManager } from "./BrowserSessionManager";
export type { BrowserHandle, BrowserSessionRecord } from "./BrowserSessionManager";

export const BROWSER_NODES = {
	"@blokjs/browser-launch": BrowserLaunchNode,
	"@blokjs/browser-close": BrowserCloseNode,
} as const;

export default BROWSER_NODES;
