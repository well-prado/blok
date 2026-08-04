import type { Context, IBlokResponse } from "@blokjs/core/runtime";
import type { Locator, Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserSessionManager } from "../src/BrowserSessionManager";
import { BrowserFillNode, BrowserGotoNode } from "../src/actions";
import { resolveLocator, resolveStrictLocator, sanitizeUrl } from "../src/locator";

const session = { sessionId: "bs_test", pageId: "bp_test" };
let artifactRoot: string;
let previousProjectRoot: string | undefined;

beforeEach(async () => {
	previousProjectRoot = process.env.BLOK_PROJECT_ROOT;
	artifactRoot = await mkdtemp(join(tmpdir(), "blok-browser-actions-"));
	process.env.BLOK_PROJECT_ROOT = artifactRoot;
});

function context(signal?: AbortSignal): Context {
	const state: Record<string, unknown> = {};
	return {
		id: "run-a",
		request: { body: {}, headers: {}, params: {}, query: {} },
		response: { data: {}, success: true, error: null },
		error: { message: [] },
		logger: {
			log: vi.fn(),
			logLevel: vi.fn(),
			error: vi.fn(),
			getLogs: () => [],
			getLogsAsText: () => "",
			getLogsAsBase64: () => "",
		},
		config: {},
		state,
		vars: state,
		eventLogger: null,
		signal,
		_PRIVATE_: {},
	} as unknown as Context;
}

function fakePage(matchCount = 1) {
	const target = {
		count: vi.fn().mockResolvedValue(matchCount),
		boundingBox: vi.fn().mockResolvedValue({ x: 1, y: 2, width: 100, height: 40 }),
		click: vi.fn().mockResolvedValue(undefined),
		fill: vi.fn().mockResolvedValue(undefined),
		waitFor: vi.fn().mockResolvedValue(undefined),
	} as unknown as Locator;
	const page = {
		getByTestId: vi.fn().mockReturnValue(target),
		getByRole: vi.fn().mockReturnValue(target),
		getByLabel: vi.fn().mockReturnValue(target),
		getByPlaceholder: vi.fn().mockReturnValue(target),
		getByText: vi.fn().mockReturnValue(target),
		locator: vi.fn().mockReturnValue(target),
		goto: vi.fn().mockResolvedValue(null),
		waitForURL: vi.fn().mockResolvedValue(undefined),
		waitForLoadState: vi.fn().mockResolvedValue(undefined),
		url: vi.fn().mockReturnValue("https://example.com/dashboard"),
		screenshot: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
	} as unknown as Page;
	return { page, target };
}

afterEach(async () => {
	vi.restoreAllMocks();
	if (previousProjectRoot === undefined) Reflect.deleteProperty(process.env, "BLOK_PROJECT_ROOT");
	else process.env.BLOK_PROJECT_ROOT = previousProjectRoot;
	await rm(artifactRoot, { recursive: true, force: true });
});

describe("browser locator resolution", () => {
	it("routes role, label, test-id, and CSS locators through Playwright", () => {
		const { page, target } = fakePage();
		expect(resolveLocator(page, { by: "role", role: "button", name: "Save", exact: true })).toBe(target);
		expect(resolveLocator(page, { by: "label", value: "Email" })).toBe(target);
		expect(resolveLocator(page, { by: "testId", value: "submit" })).toBe(target);
		expect(resolveLocator(page, { by: "css", value: "#submit" })).toBe(target);
		expect(page.getByRole).toHaveBeenCalledWith("button", { name: "Save", exact: true });
		expect(page.getByLabel).toHaveBeenCalledWith("Email", { exact: undefined });
		expect(page.getByTestId).toHaveBeenCalledWith("submit");
		expect(page.locator).toHaveBeenCalledWith("#submit");
	});

	it.each([0, 2])("fails before an action when a locator matches %i elements", async (count) => {
		const { page } = fakePage(count);
		await expect(resolveStrictLocator(page, { by: "text", value: "Continue" })).rejects.toThrow(
			`matched ${count} elements; expected exactly 1`,
		);
	});
});

describe("browser action nodes", () => {
	it("never logs or returns a password fill value", async () => {
		const { page, target } = fakePage();
		vi.spyOn(browserSessionManager, "getPage").mockReturnValue(page);
		const ctx = context();
		const secret = "correct horse battery staple";

		const response = (await BrowserFillNode.handle(ctx, {
			session,
			locator: { by: "label", value: "Password" },
			value: secret,
		})) as IBlokResponse;

		expect(response.success).toBe(true);
		expect(response.data).toMatchObject({ masked: true, matchCount: 1 });
		expect(target.fill).toHaveBeenCalledWith(secret, { timeout: 30_000 });
		expect(JSON.stringify(response.data)).not.toContain(secret);
		expect(JSON.stringify(vi.mocked(ctx.logger.log).mock.calls)).not.toContain(secret);
	});

	it("passes navigation timeout through and preserves Playwright timeout failures", async () => {
		const { page } = fakePage();
		vi.mocked(page.goto).mockRejectedValue(new Error("Timeout 17ms exceeded"));
		vi.spyOn(browserSessionManager, "getPage").mockReturnValue(page);

		const response = (await BrowserGotoNode.handle(context(), {
			session,
			url: "https://example.com/login",
			timeoutMs: 17,
			waitUntil: "load",
		})) as IBlokResponse;

		expect(response.success).toBe(false);
		expect(response.error?.message).toContain("Timeout 17ms exceeded");
		expect(page.goto).toHaveBeenCalledWith("https://example.com/login", { timeout: 17, waitUntil: "load" });
	});

	it("stops waiting when the run is cancelled", async () => {
		const { page } = fakePage();
		vi.mocked(page.goto).mockReturnValue(new Promise(() => undefined));
		vi.spyOn(browserSessionManager, "getPage").mockReturnValue(page);
		const controller = new AbortController();
		const pending = BrowserGotoNode.handle(context(controller.signal), {
			session,
			url: "https://example.com/slow",
		});

		controller.abort();
		const response = (await pending) as IBlokResponse;
		expect(response.success).toBe(false);
		expect(response.error?.message.toLowerCase()).toContain("abort");
	});

	it("redacts credentials and sensitive query parameters from reported URLs", () => {
		expect(sanitizeUrl("https://user:pass@example.com/path?token=abc&view=full")).toBe(
			"https://redacted:redacted@example.com/path?token=redacted&view=full",
		);
	});
});
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
