import { defineNode } from "@blokjs/core";
import { BlokError } from "@blokjs/core/runtime";
import { z } from "zod";
import { browserSessionManager } from "./BrowserSessionManager";
import { browserArtifactSchema, captureScreenshot, withActionScreenshot } from "./artifacts";
import { abortable, browserHandleSchema, browserLocatorSchema, resolveStrictLocator, sanitizeUrl } from "./locator";

const timeoutSchema = z.number().int().positive().max(120_000).default(30_000);
const modeSchema = z.enum(["exact", "contains", "matches"]);
const assertionOutputSchema = z.object({
	pass: z.literal(true),
	expected: z.union([z.string(), z.boolean()]),
	actual: z.union([z.string(), z.boolean()]),
	artifact: browserArtifactSchema,
});

function matches(actual: string, expected: string, mode: z.infer<typeof modeSchema>): boolean {
	if (mode === "exact") return actual === expected;
	if (mode === "contains") return actual.includes(expected);
	try {
		return new RegExp(expected).test(actual);
	} catch {
		throw BlokError.validation({
			code: "BROWSER_ASSERTION_PATTERN_INVALID",
			message: `Invalid browser assertion regular expression: ${expected}`,
			details: { expected, mode },
		});
	}
}

function assertionFailed(assertion: string, expected: unknown, actual: unknown, extra: Record<string, unknown> = {}) {
	return BlokError.validation({
		code: "BROWSER_ASSERTION_FAILED",
		message: `Browser ${assertion} assertion failed`,
		description: `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
		remediation: "Check the locator and expected value, then inspect the failure screenshot.",
		details: { assertion, expected, actual, ...extra },
	});
}

export const BrowserAssertVisibleNode = defineNode({
	name: "@blokjs/browser-assert-visible",
	description: "Asserts that exactly one located element becomes visible",
	input: z.object({ session: browserHandleSchema, locator: browserLocatorSchema, timeoutMs: timeoutSchema }),
	output: assertionOutputSchema,
	async execute(ctx, input) {
		const page = browserSessionManager.getPage(ctx.id, input.session, ctx.signal);
		return withActionScreenshot(ctx, page, "assert-visible", input.session, async () => {
			const { target } = await resolveStrictLocator(page, input.locator, ctx.signal);
			let actual = true;
			try {
				await abortable(ctx.signal, () => target.waitFor({ state: "visible", timeout: input.timeoutMs }));
			} catch (error) {
				if (ctx.signal?.aborted) throw error;
				actual = false;
			}
			if (!actual)
				throw assertionFailed("visible", true, actual, { locator: input.locator, url: sanitizeUrl(page.url()) });
			return { pass: true as const, expected: true, actual };
		});
	},
});

export const BrowserAssertTextNode = defineNode({
	name: "@blokjs/browser-assert-text",
	description: "Asserts element text using exact, contains, or regular-expression matching",
	input: z.object({
		session: browserHandleSchema,
		locator: browserLocatorSchema,
		expected: z.string(),
		mode: modeSchema.default("exact"),
		timeoutMs: timeoutSchema,
	}),
	output: assertionOutputSchema,
	async execute(ctx, input) {
		const page = browserSessionManager.getPage(ctx.id, input.session, ctx.signal);
		return withActionScreenshot(ctx, page, "assert-text", input.session, async () => {
			const { target } = await resolveStrictLocator(page, input.locator, ctx.signal);
			const actual = (await abortable(ctx.signal, () => target.textContent({ timeout: input.timeoutMs }))) ?? "";
			if (!matches(actual, input.expected, input.mode)) {
				throw assertionFailed("text", input.expected, actual, {
					mode: input.mode,
					locator: input.locator,
					url: sanitizeUrl(page.url()),
				});
			}
			return { pass: true as const, expected: input.expected, actual };
		});
	},
});

export const BrowserAssertUrlNode = defineNode({
	name: "@blokjs/browser-assert-url",
	description: "Asserts the current page URL using exact, contains, or regular-expression matching",
	input: z.object({ session: browserHandleSchema, expected: z.string(), mode: modeSchema.default("exact") }),
	output: assertionOutputSchema,
	async execute(ctx, input) {
		const page = browserSessionManager.getPage(ctx.id, input.session, ctx.signal);
		return withActionScreenshot(ctx, page, "assert-url", input.session, async () => {
			const actual = sanitizeUrl(page.url());
			if (!matches(actual, input.expected, input.mode)) {
				throw assertionFailed("URL", input.expected, actual, { mode: input.mode });
			}
			return { pass: true as const, expected: input.expected, actual };
		});
	},
});

export const BrowserScreenshotNode = defineNode({
	name: "@blokjs/browser-screenshot",
	description: "Captures a named PNG screenshot artifact",
	input: z.object({
		session: browserHandleSchema,
		name: z.string().min(1).max(100),
		fullPage: z.boolean().default(false),
	}),
	output: browserArtifactSchema,
	async execute(ctx, input) {
		const page = browserSessionManager.getPage(ctx.id, input.session, ctx.signal);
		return captureScreenshot(ctx, page, input.name, { action: "screenshot", phase: "explicit" }, input.fullPage);
	},
});
