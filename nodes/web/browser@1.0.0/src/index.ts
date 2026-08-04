import { defineNode } from "@blokjs/core";
import { registerContextCleanup, registerShutdownCleanup } from "@blokjs/runner/contextCleanup";
import { z } from "zod";
import { browserSessionManager } from "./BrowserSessionManager";
import { BrowserClickNode, BrowserFillNode, BrowserGotoNode, BrowserWaitNode } from "./actions";
import { browserHandleSchema } from "./locator";

export const BrowserLaunchNode = defineNode({
	name: "@blokjs/browser-launch",
	description: "Launches an isolated Chromium session with one page",
	input: z.object({}),
	output: browserHandleSchema,
	async execute(ctx) {
		const handle = await browserSessionManager.launch(ctx.id, ctx.signal);
		registerContextCleanup(ctx, () => browserSessionManager.closeRun(ctx.id));
		return handle;
	},
});

export const BrowserCloseNode = defineNode({
	name: "@blokjs/browser-close",
	description: "Closes the Chromium session owned by this workflow run",
	input: browserHandleSchema.pick({ sessionId: true }),
	output: z.object({ closed: z.literal(true) }),
	async execute(ctx, input) {
		await browserSessionManager.close(ctx.id, input.sessionId);
		return { closed: true as const };
	},
});

registerShutdownCleanup(() => browserSessionManager.closeAll());

export { BrowserSessionManager, browserSessionManager } from "./BrowserSessionManager";
export type { BrowserHandle, BrowserSessionRecord } from "./BrowserSessionManager";
export { BrowserClickNode, BrowserFillNode, BrowserGotoNode, BrowserWaitNode } from "./actions";
export { browserHandleSchema, browserLocatorSchema } from "./locator";
export type { BrowserLocator } from "./locator";

export const BROWSER_NODES = {
	"@blokjs/browser-launch": BrowserLaunchNode,
	"@blokjs/browser-close": BrowserCloseNode,
	"@blokjs/browser-goto": BrowserGotoNode,
	"@blokjs/browser-click": BrowserClickNode,
	"@blokjs/browser-fill": BrowserFillNode,
	"@blokjs/browser-wait": BrowserWaitNode,
} as const;

export default BROWSER_NODES;
