/**
 * Security review FW-2 — `/__blok/runs/:runId/replay` must NOT honor
 * attacker-controlled `overrides.headers` for sensitive credentials
 * (Authorization, Cookie, X-Api-Key, etc.). Combined with the FW-1
 * trace-auth gate this blocks the replay-as-auth-bypass attack where
 * an unauthenticated client posts a replay request with a forged
 * Authorization header that the runner would otherwise dispatch
 * verbatim to the user-authored route.
 *
 * The test exercises the filtered customHeaders construction by
 * intercepting `http.request`. We don't run the full HTTP round-trip;
 * we only assert that the headers handed to `http.request` exclude
 * sensitive overrides while keeping benign ones.
 */

import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunTracker } from "../../tracing/RunTracker";
import { registerTraceRoutes } from "../../tracing/TraceRouter";

interface FakeReq {
	method: string;
	params: Record<string, string>;
	query: Record<string, string | undefined>;
	headers: Record<string, string | string[] | undefined>;
	body?: unknown;
	on: (event: string, listener: () => void) => void;
}

interface FakeRes {
	statusCode: number;
	headers: Record<string, string>;
	body?: unknown;
	setHeader: (k: string, v: string) => void;
	status: (c: number) => FakeRes;
	json: (b: unknown) => void;
	write: (c: string) => boolean;
	end: () => void;
	sendStatus: (c: number) => void;
	flushHeaders: () => void;
}

type Handler = (req: FakeReq, res: FakeRes, next?: () => void) => void;

class FakeRouter {
	middleware: Handler[] = [];
	routes: Map<string, Handler> = new Map();
	use(h: Handler): void {
		this.middleware.push(h);
	}
	get(path: string, h: Handler): void {
		this.routes.set(`GET ${path}`, h);
	}
	post(path: string, h: Handler): void {
		this.routes.set(`POST ${path}`, h);
	}
	put(_p: string, _h: Handler): void {}
	delete(_p: string, _h: Handler): void {}
}

function makeRes(): FakeRes {
	const res: FakeRes = {
		statusCode: 200,
		headers: {},
		setHeader(k, v) {
			res.headers[k] = v;
		},
		status(c) {
			res.statusCode = c;
			return res;
		},
		json(b) {
			res.body = b;
		},
		write() {
			return true;
		},
		end() {},
		sendStatus(c) {
			res.statusCode = c;
		},
		flushHeaders() {},
	};
	return res;
}

function makeReq(overrides?: Partial<FakeReq>): FakeReq {
	return {
		method: "POST",
		params: {},
		query: {},
		headers: { host: "localhost:4000" },
		on: () => {},
		...overrides,
	};
}

describe("Security review FW-2 — replay endpoint filters sensitive headers from overrides", () => {
	let tracker: RunTracker;
	let router: FakeRouter;
	let httpRequestSpy: ReturnType<typeof vi.spyOn>;
	let capturedRequestOpts: http.RequestOptions[] = [];

	beforeEach(() => {
		RunTracker.resetInstance();
		tracker = RunTracker.getInstance();
		router = new FakeRouter();
		registerTraceRoutes(router as unknown as Parameters<typeof registerTraceRoutes>[0], tracker);

		// Intercept http.request to capture the headers without firing
		// a real network request. Return a fake ClientRequest that
		// no-ops on .end()/.write() so the handler doesn't hang.
		capturedRequestOpts = [];
		httpRequestSpy = vi.spyOn(http, "request").mockImplementation(((opts: http.RequestOptions) => {
			capturedRequestOpts.push(opts);
			return {
				on: () => {},
				write: () => true,
				end: () => {},
			} as unknown as http.ClientRequest;
		}) as unknown as typeof http.request);
	});

	afterEach(() => {
		httpRequestSpy.mockRestore();
		RunTracker.resetInstance();
	});

	function fireReplay(overrideHeaders: Record<string, string>) {
		const run = tracker.startRun({
			workflowName: "test-wf",
			workflowPath: "/test",
			triggerType: "http",
			triggerSummary: "POST /api/test",
			nodeCount: 1,
		});

		const replayHandler = router.routes.get("POST /runs/:runId/replay");
		expect(replayHandler).toBeDefined();
		const req = makeReq({
			params: { runId: run.id },
			body: { headers: overrideHeaders },
		});
		const res = makeRes();
		replayHandler?.(req, res);
		return { runId: run.id, res };
	}

	it("strips Authorization from overrides.headers", () => {
		fireReplay({ Authorization: "Bearer attacker_token", "X-Tenant": "t-7" });

		expect(capturedRequestOpts).toHaveLength(1);
		const headers = capturedRequestOpts[0].headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
		expect(headers.authorization).toBeUndefined();
		expect(headers["X-Tenant"]).toBe("t-7");
	});

	it("strips Cookie from overrides.headers", () => {
		fireReplay({ Cookie: "session=stolen", "X-Trace-Id": "t-1" });
		const headers = capturedRequestOpts[0].headers as Record<string, string>;
		expect(headers.Cookie).toBeUndefined();
		expect(headers.cookie).toBeUndefined();
		expect(headers["X-Trace-Id"]).toBe("t-1");
	});

	it("strips X-Api-Key from overrides.headers (case-insensitive)", () => {
		fireReplay({ "x-api-key": "sk_attacker", "X-API-KEY": "another" });
		const headers = capturedRequestOpts[0].headers as Record<string, string>;
		expect(headers["x-api-key"]).toBeUndefined();
		expect(headers["X-API-KEY"]).toBeUndefined();
	});

	it("strips Proxy-Authorization and X-Auth-Token", () => {
		fireReplay({
			"Proxy-Authorization": "Basic xxx",
			"x-auth-token": "yyy",
			"X-Custom": "kept",
		});
		const headers = capturedRequestOpts[0].headers as Record<string, string>;
		expect(headers["Proxy-Authorization"]).toBeUndefined();
		expect(headers["x-auth-token"]).toBeUndefined();
		expect(headers["X-Custom"]).toBe("kept");
	});

	it("attacker cannot override X-Blok-Replay-Of via overrides.headers", () => {
		const { runId } = fireReplay({ "X-Blok-Replay-Of": "run_attacker_choice" });
		const headers = capturedRequestOpts[0].headers as Record<string, string>;
		// Framework-controlled lineage header wins over the override.
		expect(headers["X-Blok-Replay-Of"]).toBe(runId);
	});

	it("preserves benign overrides.headers (Content-Type, custom)", () => {
		fireReplay({
			"Content-Type": "application/x-www-form-urlencoded",
			"X-Custom-Trace": "t-7",
		});
		const headers = capturedRequestOpts[0].headers as Record<string, string>;
		expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
		expect(headers["X-Custom-Trace"]).toBe("t-7");
	});
});
