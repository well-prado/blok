import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createTraceRouterAdapter } from "../../src/runner/HonoTraceRouterAdapter";

class TestResponse extends EventEmitter {
	headersSent = false;
	writableEnded = false;
	statusCode = 200;
	body = "";
	readonly headers = new Map<string, string>();

	setHeader(name: string, value: string) {
		this.headers.set(name, value);
	}

	writeHead(statusCode: number, headers?: Record<string, string>) {
		this.statusCode = statusCode;
		this.headersSent = true;
		for (const [name, value] of Object.entries(headers ?? {})) this.setHeader(name, value);
	}

	write(chunk: string) {
		this.body += chunk;
		return true;
	}

	end(chunk?: string) {
		if (chunk) this.body += chunk;
		this.writableEnded = true;
		this.emit("finish");
	}

	flushHeaders() {
		this.headersSent = true;
	}
}

async function request(
	traceApp: ReturnType<typeof createTraceRouterAdapter>["traceApp"],
	path: string,
): Promise<TestResponse> {
	const incoming = new EventEmitter() as IncomingMessage;
	const outgoing = new TestResponse();
	await traceApp.request(`http://localhost${path}`, undefined, {
		incoming,
		outgoing: outgoing as unknown as ServerResponse,
	});
	return outgoing;
}

describe("HonoTraceRouterAdapter", () => {
	it("awaits async trace handlers", async () => {
		const { traceAdapter, traceApp } = createTraceRouterAdapter();
		traceAdapter.get("/async", async (_req, res) => {
			await Promise.resolve();
			res.json({ ready: true });
		});

		const response = await request(traceApp, "/async");
		expect(JSON.parse(response.body)).toEqual({ ready: true });
	});

	it("does not call a route after middleware sends a response", async () => {
		const { traceAdapter, traceApp } = createTraceRouterAdapter();
		let called = false;
		traceAdapter.use((_req, res) => res.status(401).json({ error: "Unauthorized" }));
		traceAdapter.get("/blocked", (_req, res) => {
			called = true;
			res.json({ ok: true });
		});

		const response = await request(traceApp, "/blocked");
		expect(response.statusCode).toBe(401);
		expect(called).toBe(false);
	});
});
