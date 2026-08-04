import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Context,
	type IBlokResponse,
	RunTracker,
	registerContextCleanup,
	runContextCleanups,
} from "@blokjs/core/runtime";
import type { Locator, Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserSessionManager } from "../src/BrowserSessionManager";
import { BrowserAssertTextNode, BrowserScreenshotNode } from "../src/assertions";

const session = { sessionId: "bs_test", pageId: "bp_test" };
let artifactRoot: string;
let previousProjectRoot: string | undefined;

function tracedContext(runId: string, nodeRunId: string): Context {
	return {
		id: "request-a",
		request: { body: {} },
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
		state: {},
		vars: {},
		eventLogger: null,
		_PRIVATE_: {},
		_traceRunId: runId,
		_traceNodeId: nodeRunId,
	} as unknown as Context;
}

function pageWithText(text: string, order: string[]) {
	const locator = {
		count: vi.fn().mockResolvedValue(1),
		textContent: vi.fn().mockResolvedValue(text),
	} as unknown as Locator;
	return {
		getByText: vi.fn().mockReturnValue(locator),
		url: vi.fn().mockReturnValue("https://example.com/result"),
		screenshot: vi.fn().mockImplementation(async () => {
			order.push("capture");
			return new Uint8Array([1, 2, 3]);
		}),
	} as unknown as Page;
}

beforeEach(async () => {
	previousProjectRoot = process.env.BLOK_PROJECT_ROOT;
	artifactRoot = await mkdtemp(join(tmpdir(), "blok-browser-assertions-"));
	process.env.BLOK_PROJECT_ROOT = artifactRoot;
	process.env.BLOK_TRACE_STORE = "memory";
	RunTracker.resetInstance();
});

afterEach(async () => {
	vi.restoreAllMocks();
	RunTracker.resetInstance();
	Reflect.deleteProperty(process.env, "BLOK_TRACE_STORE");
	if (previousProjectRoot === undefined) Reflect.deleteProperty(process.env, "BLOK_PROJECT_ROOT");
	else process.env.BLOK_PROJECT_ROOT = previousProjectRoot;
	await rm(artifactRoot, { recursive: true, force: true });
});

describe("browser assertions and artifacts", () => {
	it("stores expected/actual details and captures the failure before context cleanup", async () => {
		const tracker = RunTracker.getInstance();
		const run = tracker.startRun({
			workflowName: "browser-test",
			workflowPath: "test.ts",
			triggerType: "manual",
			triggerSummary: "test",
			nodeCount: 1,
		});
		const node = tracker.startNode(run.id, { nodeName: "assert-title", nodeType: "module", depth: 0, stepIndex: 0 });
		const order: string[] = [];
		const page = pageWithText("Actual title", order);
		vi.spyOn(browserSessionManager, "getPage").mockReturnValue(page);
		const ctx = tracedContext(run.id, node.id);
		registerContextCleanup(ctx, () => order.push("close"));

		const response = (await BrowserAssertTextNode.handle(ctx, {
			session,
			locator: { by: "text", value: "Actual title" },
			expected: "Expected title",
		})) as IBlokResponse;
		tracker.failNode(node.id, response.error);
		await runContextCleanups(ctx);

		const stored = tracker.getNodeRun(node.id);
		expect(response.success).toBe(false);
		expect(stored?.error?.details).toMatchObject({ expected: "Expected title", actual: "Actual title" });
		expect(stored?.artifacts?.[0]).toMatchObject({ nodeRunId: node.id, runId: run.id, kind: "screenshot" });
		expect(tracker.getEvents(run.id).map((event) => event.type)).toEqual(
			expect.arrayContaining(["BROWSER_ACTION", "BROWSER_ARTIFACT"]),
		);
		expect(order).toEqual(["capture", "close"]);
	});

	it("returns explicit screenshot metadata without a filesystem path", async () => {
		const page = pageWithText("ok", []);
		vi.spyOn(browserSessionManager, "getPage").mockReturnValue(page);
		const response = (await BrowserScreenshotNode.handle(tracedContext("run_test", "node_test"), {
			session,
			name: "checkout-ready",
		})) as IBlokResponse;

		expect(response.success).toBe(true);
		expect(response.data).toMatchObject({ name: "checkout-ready", kind: "screenshot", mimeType: "image/png" });
		expect(response.data).not.toHaveProperty("path");
	});
});
