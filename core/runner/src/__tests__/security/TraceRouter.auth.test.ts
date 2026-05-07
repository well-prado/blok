/**
 * Security review FW-1 + FW-4 — `/__blok/*` production-default-deny +
 * `setTraceAuth` hook + CORS allowlist.
 *
 * Tests the authorize middleware in `registerTraceRoutes`. Uses a
 * minimal fake Router/Request/Response triple to avoid pulling in
 * Hono / Express in unit tests.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { RunTracker } from "../../tracing/RunTracker";
import { type TraceAuthorizeFn, type TraceRouterOptions, registerTraceRoutes } from "../../tracing/TraceRouter";

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
	use(handler: Handler): void {
		this.middleware.push(handler);
	}
	get(_path: string, _handler: Handler): void {}
	post(_path: string, _handler: Handler): void {}
	put(_path: string, _handler: Handler): void {}
	delete(_path: string, _handler: Handler): void {}
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
		method: "GET",
		params: {},
		query: {},
		headers: {},
		on: () => {},
		...overrides,
	};
}

/**
 * Drive only the FIRST middleware (the auth + CORS gate). The route
 * handlers are registered after the gate; we don't need to reach them
 * for the gate's own behavior.
 */
async function runGate(
	options: TraceRouterOptions | undefined,
	req: FakeReq,
): Promise<{ res: FakeRes; nextCalled: boolean }> {
	const router = new FakeRouter();
	registerTraceRoutes(router as unknown as Parameters<typeof registerTraceRoutes>[0], undefined, options);
	const gate = router.middleware[0];
	const res = makeRes();
	let nextCalled = false;
	gate(req, res, () => {
		nextCalled = true;
	});
	// Yield to flush promise-chained .then() in the authorize path.
	await new Promise((r) => setTimeout(r, 5));
	return { res, nextCalled };
}

describe("Security review FW-1 — /__blok/* production-default-deny + setTraceAuth", () => {
	const originalEnv = { ...process.env };

	function setEnv(updates: Record<string, string | undefined>) {
		const next = { ...originalEnv } as NodeJS.ProcessEnv;
		for (const [k, v] of Object.entries(updates)) {
			next[k] = (v === undefined ? undefined : v) as string;
		}
		process.env = next;
	}

	afterEach(() => {
		process.env = { ...originalEnv };
		RunTracker.resetInstance();
	});

	it("dev mode (BLOK_ENV unset, NODE_ENV unset) passes through without auth", async () => {
		setEnv({ BLOK_ENV: undefined, NODE_ENV: undefined });
		const { res, nextCalled } = await runGate(undefined, makeReq());
		expect(nextCalled).toBe(true);
		expect(res.statusCode).toBe(200);
	});

	it("production without authorize hook returns 503 with a hint", async () => {
		setEnv({ BLOK_ENV: "production" });
		const { res, nextCalled } = await runGate(undefined, makeReq());
		expect(nextCalled).toBe(false);
		expect(res.statusCode).toBe(503);
		const body = res.body as { error: string; hint: string; docs: string };
		expect(body.error).toMatch(/require auth in production/);
		expect(body.hint).toMatch(/setTraceAuth|BLOK_TRACE_AUTH_DISABLED/);
		expect(body.docs).toMatch(/security\/cookbook/);
	});

	it("production with authorize() returning true allows the request", async () => {
		setEnv({ BLOK_ENV: "production" });
		const authorize: TraceAuthorizeFn = vi.fn().mockReturnValue(true);
		const { nextCalled, res } = await runGate({ authorize }, makeReq());
		expect(authorize).toHaveBeenCalled();
		expect(nextCalled).toBe(true);
		expect(res.statusCode).toBe(200);
	});

	it("production with authorize() returning false rejects with 401", async () => {
		setEnv({ BLOK_ENV: "production" });
		const authorize: TraceAuthorizeFn = vi.fn().mockReturnValue(false);
		const { nextCalled, res } = await runGate({ authorize }, makeReq());
		expect(authorize).toHaveBeenCalled();
		expect(nextCalled).toBe(false);
		expect(res.statusCode).toBe(401);
		expect(res.body).toEqual({ error: "Unauthorized" });
	});

	it("production with async authorize() resolving to true allows the request", async () => {
		setEnv({ BLOK_ENV: "production" });
		const authorize: TraceAuthorizeFn = async () => true;
		const { nextCalled } = await runGate({ authorize }, makeReq());
		expect(nextCalled).toBe(true);
	});

	it("production with authorize() throwing returns 401 (does not leak error)", async () => {
		setEnv({ BLOK_ENV: "production" });
		const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
		const authorize: TraceAuthorizeFn = () => {
			throw new Error("token verification failed: secret_xyz");
		};
		const { nextCalled, res } = await runGate({ authorize }, makeReq());
		expect(nextCalled).toBe(false);
		expect(res.statusCode).toBe(401);
		expect(res.body).toEqual({ error: "Unauthorized" });
		// Error logged to stderr but body doesn't leak the message.
		expect(consoleErr).toHaveBeenCalled();
		consoleErr.mockRestore();
	});

	it("BLOK_TRACE_AUTH_DISABLED=1 in production passes through (firewall-elsewhere mode)", async () => {
		setEnv({ BLOK_ENV: "production", BLOK_TRACE_AUTH_DISABLED: "1" });
		const { nextCalled, res } = await runGate(undefined, makeReq());
		expect(nextCalled).toBe(true);
		expect(res.statusCode).toBe(200);
	});

	it("NODE_ENV=production triggers the gate even without BLOK_ENV", async () => {
		setEnv({ BLOK_ENV: undefined, NODE_ENV: "production" });
		const { nextCalled, res } = await runGate(undefined, makeReq());
		expect(nextCalled).toBe(false);
		expect(res.statusCode).toBe(503);
	});
});

describe("Security review FW-4 — CORS allowlist via BLOK_TRACE_CORS_ORIGIN", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
		RunTracker.resetInstance();
	});

	it("default CORS origin is `*` (back-compat with previous behaviour)", async () => {
		process.env = { ...originalEnv, BLOK_TRACE_CORS_ORIGIN: undefined as unknown as string };
		const { res } = await runGate(undefined, makeReq());
		expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
	});

	it("BLOK_TRACE_CORS_ORIGIN restricts to a single origin", async () => {
		process.env = {
			...originalEnv,
			BLOK_TRACE_CORS_ORIGIN: "https://studio.example.com",
		};
		const { res } = await runGate(undefined, makeReq());
		expect(res.headers["Access-Control-Allow-Origin"]).toBe("https://studio.example.com");
	});

	it("preflight OPTIONS request returns 204 with CORS headers", async () => {
		process.env = {
			...originalEnv,
			BLOK_TRACE_CORS_ORIGIN: "https://studio.example.com",
		};
		const { res, nextCalled } = await runGate(undefined, makeReq({ method: "OPTIONS" }));
		expect(nextCalled).toBe(false);
		expect(res.statusCode).toBe(204);
		expect(res.headers["Access-Control-Allow-Origin"]).toBe("https://studio.example.com");
		expect(res.headers["Access-Control-Allow-Methods"]).toContain("GET");
	});
});
