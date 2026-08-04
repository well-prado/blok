import type { Locator, Page } from "playwright";
import { z } from "zod";

export const browserHandleSchema = z.object({
	sessionId: z.string().min(1),
	pageId: z.string().min(1),
});

export const browserLocatorSchema = z.discriminatedUnion("by", [
	z.object({ by: z.literal("testId"), value: z.string().min(1) }),
	z.object({
		by: z.literal("role"),
		role: z.string().min(1),
		name: z.string().min(1).optional(),
		exact: z.boolean().optional(),
	}),
	z.object({ by: z.literal("label"), value: z.string().min(1), exact: z.boolean().optional() }),
	z.object({ by: z.literal("placeholder"), value: z.string().min(1), exact: z.boolean().optional() }),
	z.object({ by: z.literal("text"), value: z.string().min(1), exact: z.boolean().optional() }),
	z.object({ by: z.literal("css"), value: z.string().min(1) }),
]);

export type BrowserLocator = z.infer<typeof browserLocatorSchema>;

export function resolveLocator(page: Page, locator: BrowserLocator): Locator {
	switch (locator.by) {
		case "testId":
			return page.getByTestId(locator.value);
		case "role":
			return page.getByRole(locator.role as Parameters<Page["getByRole"]>[0], {
				name: locator.name,
				exact: locator.exact,
			});
		case "label":
			return page.getByLabel(locator.value, { exact: locator.exact });
		case "placeholder":
			return page.getByPlaceholder(locator.value, { exact: locator.exact });
		case "text":
			return page.getByText(locator.value, { exact: locator.exact });
		case "css":
			return page.locator(locator.value);
	}
}

export async function abortable<T>(signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
	if (!signal) return action();
	signal.throwIfAborted();
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<T>((_, reject) => {
		onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([action(), aborted]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

export async function resolveStrictLocator(
	page: Page,
	locator: BrowserLocator,
	signal?: AbortSignal,
): Promise<{ target: Locator; matchCount: 1 }> {
	const target = resolveLocator(page, locator);
	const count = await abortable(signal, () => target.count());
	if (count !== 1) {
		throw new Error(`Browser locator ${JSON.stringify(locator)} matched ${count} elements; expected exactly 1`);
	}
	return { target, matchCount: 1 };
}

export function isSensitiveLocator(locator: BrowserLocator): boolean {
	const text = locator.by === "role" ? (locator.name ?? locator.role) : locator.value;
	return /password|passcode|secret|token/i.test(text);
}

export function sanitizeUrl(value: string): string {
	try {
		const url = new URL(value);
		if (url.username) url.username = "redacted";
		if (url.password) url.password = "redacted";
		for (const key of url.searchParams.keys()) {
			if (/token|secret|password|passcode|api[-_]?key|auth|session/i.test(key)) url.searchParams.set(key, "redacted");
		}
		return url.toString();
	} catch {
		return value;
	}
}
