/**
 * Adapter that bridges the TraceRouter interface from @blok/runner to Hono.
 *
 * The core/runner package defines a TraceRouter interface that matches Express's
 * Router API surface (use, get, post, put, delete). This adapter implements that
 * interface by wrapping each registered handler into a Hono route handler that:
 *   1. Builds a TraceRequest from the Hono context + raw Node.js IncomingMessage
 *   2. Builds a TraceResponse that writes to the raw Node.js ServerResponse
 *   3. Returns RESPONSE_ALREADY_SENT so Hono doesn't try to write its own response
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { Hono } from "hono";

type AppBindings = { Bindings: HttpBindings };

/** Mirrors the TraceRequest interface in core/runner/src/tracing/TraceRouter.ts */
interface TraceRequest {
	method: string;
	params: Record<string, string>;
	query: Record<string, string | undefined>;
	headers: Record<string, string | string[] | undefined>;
	body?: unknown;
	on(event: string, listener: () => void): void;
}

/** Mirrors the TraceResponse interface in core/runner/src/tracing/TraceRouter.ts */
interface TraceResponse {
	setHeader(name: string, value: string): void;
	status(code: number): TraceResponse;
	json(body: unknown): void;
	write(chunk: string): boolean;
	end(): void;
	sendStatus(code: number): void;
	flushHeaders(): void;
}

/**
 * Build a TraceRequest from a Hono context and the raw Node.js request.
 */
function buildTraceRequest(
	incoming: IncomingMessage,
	method: string,
	params: Record<string, string>,
	query: Record<string, string | undefined>,
	headers: Record<string, string | string[] | undefined>,
	body?: unknown,
): TraceRequest {
	return {
		method,
		params,
		query,
		headers,
		body,
		on(event: string, listener: () => void) {
			incoming.on(event, listener);
		},
	};
}

/**
 * Build a TraceResponse that wraps the raw Node.js ServerResponse.
 */
function buildTraceResponse(outgoing: ServerResponse): TraceResponse {
	let statusCode = 200;

	const traceRes: TraceResponse = {
		setHeader(name: string, value: string) {
			if (!outgoing.headersSent) {
				outgoing.setHeader(name, value);
			}
		},
		status(code: number) {
			statusCode = code;
			return traceRes;
		},
		json(body: unknown) {
			if (!outgoing.headersSent) {
				outgoing.writeHead(statusCode, { "Content-Type": "application/json" });
			}
			outgoing.end(JSON.stringify(body));
		},
		write(chunk: string) {
			return outgoing.write(chunk);
		},
		end() {
			outgoing.end();
		},
		sendStatus(code: number) {
			outgoing.writeHead(code);
			outgoing.end();
		},
		flushHeaders() {
			if (!outgoing.headersSent) {
				outgoing.writeHead(statusCode);
			}
			if (typeof outgoing.flushHeaders === "function") {
				outgoing.flushHeaders();
			}
		},
	};

	return traceRes;
}

type TraceHandler = (req: TraceRequest, res: TraceResponse) => void;
type TraceMiddleware = (req: TraceRequest, res: TraceResponse, next: () => void) => void;

/**
 * Creates a Hono sub-app that adapts the TraceRouter interface.
 *
 * Returns:
 * - `traceAdapter`: Object implementing the TraceRouter interface (use/get/post/put/delete)
 * - `traceApp`: The Hono sub-app to be mounted on the main app
 */
export function createTraceRouterAdapter() {
	const traceApp = new Hono<AppBindings>();

	// Store middleware to run before each handler
	const middlewares: TraceMiddleware[] = [];

	function wrapHandler(handler: TraceHandler) {
		return async (c: import("hono").Context<AppBindings>) => {
			const incoming = c.env.incoming;
			const outgoing = c.env.outgoing;

			const url = new URL(c.req.url);
			const query: Record<string, string | undefined> = {};
			for (const [key, value] of url.searchParams.entries()) {
				query[key] = value;
			}

			// Parse body for POST/PUT requests
			let body: unknown;
			if (c.req.method === "POST" || c.req.method === "PUT") {
				try {
					body = await c.req.json();
				} catch {
					body = undefined;
				}
			}

			const traceReq = buildTraceRequest(
				incoming,
				c.req.method,
				(c.req.param() as Record<string, string>) || {},
				query,
				Object.fromEntries([...c.req.raw.headers.entries()].map(([k, v]) => [k, v])),
				body,
			);
			const traceRes = buildTraceResponse(outgoing);

			// Run middleware chain
			let middlewareIndex = 0;
			const runMiddleware = (): Promise<void> => {
				return new Promise<void>((resolve) => {
					if (middlewareIndex >= middlewares.length) {
						resolve();
						return;
					}
					const mw = middlewares[middlewareIndex++];
					mw(traceReq, traceRes, () => {
						runMiddleware().then(resolve);
					});
				});
			};

			await runMiddleware();

			// Call the route handler
			handler(traceReq, traceRes);

			// The handler writes directly to outgoing — tell Hono not to send its own response
			return RESPONSE_ALREADY_SENT;
		};
	}

	const traceAdapter = {
		use(handler: TraceMiddleware) {
			middlewares.push(handler);
		},
		get(path: string, handler: TraceHandler) {
			traceApp.get(path, wrapHandler(handler));
		},
		post(path: string, handler: TraceHandler) {
			traceApp.post(path, wrapHandler(handler));
		},
		put(path: string, handler: TraceHandler) {
			traceApp.put(path, wrapHandler(handler));
		},
		delete(path: string, handler: TraceHandler) {
			traceApp.delete(path, wrapHandler(handler));
		},
	};

	return { traceAdapter, traceApp };
}
