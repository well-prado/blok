import { setTimeout as delay } from "node:timers/promises";
import { defineNode } from "@blokjs/core";
import { z } from "zod";
import { browserSessionManager } from "./BrowserSessionManager";
import { browserArtifactSchema, withActionScreenshot } from "./artifacts";
import {
	abortable,
	browserHandleSchema,
	browserLocatorSchema,
	isSensitiveLocator,
	resolveLocator,
	resolveStrictLocator,
	sanitizeUrl,
} from "./locator";

const timeoutSchema = z.number().int().positive().max(120_000).default(30_000);
const sessionInput = { session: browserHandleSchema };
const boxSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable();
const actionOutputSchema = z.object({
	locator: browserLocatorSchema,
	matchCount: z.literal(1),
	box: boxSchema,
	url: z.string(),
	durationMs: z.number().nonnegative(),
	artifact: browserArtifactSchema,
});
const httpUrlSchema = z
	.string()
	.url()
	.refine((value) => {
		const protocol = new URL(value).protocol;
		return protocol === "http:" || protocol === "https:";
	}, "URL must use http or https");

export const BrowserGotoNode = defineNode({
	name: "@blokjs/browser-goto",
	description: "Navigates the current browser page to an HTTP(S) URL",
	input: z.object({
		...sessionInput,
		url: httpUrlSchema,
		waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).default("domcontentloaded"),
		timeoutMs: timeoutSchema,
	}),
	output: z.object({
		url: z.string(),
		status: z.number().int().nullable(),
		durationMs: z.number().nonnegative(),
		artifact: browserArtifactSchema,
	}),
	async execute(ctx, input) {
		const page = browserSessionManager.getPage(ctx.id, input.session, ctx.signal);
		return withActionScreenshot(ctx, page, "goto", input.session, async () => {
			const started = performance.now();
			ctx.logger.log(`[blok][browser] goto ${sanitizeUrl(input.url)}`);
			const response = await abortable(ctx.signal, () =>
				page.goto(input.url, { waitUntil: input.waitUntil, timeout: input.timeoutMs }),
			);
			return {
				url: sanitizeUrl(page.url()),
				status: response?.status() ?? null,
				durationMs: performance.now() - started,
			};
		});
	},
});

export const BrowserClickNode = defineNode({
	name: "@blokjs/browser-click",
	description: "Clicks exactly one element resolved from a structured locator",
	input: z.object({ ...sessionInput, locator: browserLocatorSchema, timeoutMs: timeoutSchema }),
	output: actionOutputSchema,
	async execute(ctx, input) {
		const page = browserSessionManager.getPage(ctx.id, input.session, ctx.signal);
		return withActionScreenshot(ctx, page, "click", input.session, async () => {
			const started = performance.now();
			const { target, matchCount } = await resolveStrictLocator(page, input.locator, ctx.signal);
			const box = await abortable(ctx.signal, () => target.boundingBox());
			ctx.logger.log(`[blok][browser] click ${JSON.stringify(input.locator)}`);
			await abortable(ctx.signal, () => target.click({ timeout: input.timeoutMs }));
			return {
				locator: input.locator,
				matchCount,
				box,
				url: sanitizeUrl(page.url()),
				durationMs: performance.now() - started,
			};
		});
	},
});

export const BrowserFillNode = defineNode({
	name: "@blokjs/browser-fill",
	description: "Replaces the value of exactly one element without logging the supplied value",
	input: z.object({
		...sessionInput,
		locator: browserLocatorSchema,
		value: z.string(),
		sensitive: z.boolean().optional(),
		timeoutMs: timeoutSchema,
	}),
	output: actionOutputSchema.extend({ masked: z.boolean() }),
	async execute(ctx, input) {
		const page = browserSessionManager.getPage(ctx.id, input.session, ctx.signal);
		return withActionScreenshot(ctx, page, "fill", input.session, async () => {
			const started = performance.now();
			const { target, matchCount } = await resolveStrictLocator(page, input.locator, ctx.signal);
			const box = await abortable(ctx.signal, () => target.boundingBox());
			const masked = input.sensitive ?? isSensitiveLocator(input.locator);
			ctx.logger.log(`[blok][browser] fill ${JSON.stringify(input.locator)}${masked ? " [value redacted]" : ""}`);
			await abortable(ctx.signal, () => target.fill(input.value, { timeout: input.timeoutMs }));
			return {
				locator: input.locator,
				matchCount,
				box,
				url: sanitizeUrl(page.url()),
				durationMs: performance.now() - started,
				masked,
			};
		});
	},
});

const waitConditionSchema = z.discriminatedUnion("for", [
	z.object({ for: z.literal("url"), value: z.string().min(1), timeoutMs: timeoutSchema }),
	z.object({
		for: z.literal("loadState"),
		state: z.enum(["load", "domcontentloaded", "networkidle"]).default("load"),
		timeoutMs: timeoutSchema,
	}),
	z.object({ for: z.literal("visible"), locator: browserLocatorSchema, timeoutMs: timeoutSchema }),
	z.object({ for: z.literal("duration"), durationMs: z.number().int().nonnegative().max(120_000) }),
]);

export const BrowserWaitNode = defineNode({
	name: "@blokjs/browser-wait",
	description: "Waits for a URL, load state, one visible element, or a bounded duration",
	input: z.object({ ...sessionInput, condition: waitConditionSchema }),
	output: z.object({
		condition: waitConditionSchema,
		url: z.string(),
		durationMs: z.number().nonnegative(),
		matchCount: z.literal(1).optional(),
		artifact: browserArtifactSchema,
	}),
	async execute(ctx, input) {
		const page = browserSessionManager.getPage(ctx.id, input.session, ctx.signal);
		return withActionScreenshot(ctx, page, "wait", input.session, async () => {
			const started = performance.now();
			const condition = input.condition;
			let matchCount: 1 | undefined;
			switch (condition.for) {
				case "url":
					await abortable(ctx.signal, () => page.waitForURL(condition.value, { timeout: condition.timeoutMs }));
					break;
				case "loadState":
					await abortable(ctx.signal, () => page.waitForLoadState(condition.state, { timeout: condition.timeoutMs }));
					break;
				case "visible": {
					const target = resolveLocator(page, condition.locator);
					await abortable(ctx.signal, () => target.waitFor({ state: "visible", timeout: condition.timeoutMs }));
					({ matchCount } = await resolveStrictLocator(page, condition.locator, ctx.signal));
					break;
				}
				case "duration":
					await delay(condition.durationMs, undefined, { signal: ctx.signal });
					break;
			}
			ctx.logger.log(`[blok][browser] wait ${condition.for}`);
			return {
				condition: condition.for === "url" ? { ...condition, value: sanitizeUrl(condition.value) } : condition,
				url: sanitizeUrl(page.url()),
				durationMs: performance.now() - started,
				...(matchCount ? { matchCount } : {}),
			};
		});
	},
});
