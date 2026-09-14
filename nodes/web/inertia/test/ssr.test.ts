import { type Server, createServer } from "node:http";
import { runNode } from "@blokjs/core/testing";
import { GlobalError, type RespondEnvelope } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InertiaNode, { _resetSsr, configureSsr, disableSsr, onSsrRenderFailed, withoutSsr } from "../src/index.js";

interface Stub {
	server: Server;
	url: string;
	calls: number;
}

const servers: Server[] = [];

async function stub(handler: (response: import("node:http").ServerResponse) => void): Promise<Stub> {
	const state = { calls: 0 };
	const server = createServer((_request, response) => {
		state.calls++;
		handler(response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	servers.push(server);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("stub did not bind");
	return {
		server,
		url: `http://127.0.0.1:${address.port}/render`,
		get calls() {
			return state.calls;
		},
	};
}

async function run(input: Record<string, unknown>, logger?: unknown): Promise<RespondEnvelope> {
	return (await runNode(InertiaNode, input as never, logger ? ({ logger } as never) : undefined)) as RespondEnvelope;
}

beforeEach(() => {
	vi.unstubAllEnvs();
	_resetSsr();
});

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections?.();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

describe("#1001 Inertia v3 SSR wire contract", () => {
	it("1 — splices the returned head and body at the shell markers", async () => {
		const ssr = await stub((response) => {
			response.setHeader("Content-Type", "application/json");
			response.end(
				JSON.stringify({
					head: ["<title>T</title>"],
					body: '<div id="app" data-server-rendered="true">hi</div>',
				}),
			);
		});
		configureSsr({ url: ssr.url, ensureBundleExists: false });

		const response = await run({ component: "Home", url: "/" });
		const html = response.body as string;
		expect(html).toContain("<title>T</title>");
		expect(html).toContain('data-server-rendered="true">hi</div>');
		expect(html).not.toContain('type="application/json"');
		expect(ssr.calls).toBe(1);
	});

	it("2 — never dispatches X-Inertia, prefetch, or 409 responses", async () => {
		const ssr = await stub((response) => response.end(JSON.stringify({ head: [], body: "ssr" })));
		configureSsr({ url: ssr.url, ensureBundleExists: false });

		await run({ component: "Home", url: "/", headers: { "X-Inertia": "true" } });
		await run({ component: "Home", url: "/", headers: { Purpose: "prefetch" } });
		const conflict = await run({
			component: "Home",
			url: "/",
			version: "v2",
			headers: { "X-Inertia": "true", "X-Inertia-Version": "v1" },
		});
		expect(conflict.status).toBe(409);
		expect(ssr.calls).toBe(0);
	});

	it("3 — falls back, emits the failure, and logs once per version + component", async () => {
		const ssr = await stub((response) => {
			response.statusCode = 500;
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify({ error: "render exploded", type: "render", hint: "check Home" }));
		});
		configureSsr({ url: ssr.url, ensureBundleExists: false });
		const events: unknown[] = [];
		onSsrRenderFailed((event) => events.push(event));
		const logs: string[] = [];
		const logger = { logLevel: (_level: string, message: string) => logs.push(message), getLogs: () => logs };

		const first = await run({ component: "Home", url: "/", version: "v1" }, logger);
		const second = await run({ component: "Home", url: "/", version: "v1" }, logger);
		expect(first.status).toBe(200);
		expect(first.body).toContain('type="application/json"');
		expect(second.status).toBe(200);
		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({ error: "render exploded", type: "render", hint: "check Home" });
		expect(logs).toHaveLength(1);
	});

	it("4 — classifies an unreachable server as a connection failure", async () => {
		const closed = await stub((response) => response.end());
		await new Promise<void>((resolve) => closed.server.close(() => resolve()));
		servers.splice(servers.indexOf(closed.server), 1);
		configureSsr({ url: closed.url, ensureBundleExists: false });
		const events: Array<{ type: string }> = [];
		onSsrRenderFailed((event) => events.push(event));

		const response = await run({ component: "Home", url: "/" });
		expect(response.status).toBe(200);
		expect(events).toMatchObject([{ type: "connection" }]);
	});

	it("5 — throwOnError surfaces the SSR JSON as a 500 GlobalError", async () => {
		const ssr = await stub((response) => {
			response.statusCode = 500;
			response.end(JSON.stringify({ error: "bad render", type: "render" }));
		});
		configureSsr({ url: ssr.url, ensureBundleExists: false, throwOnError: true });

		const result = await InertiaNode.handle(
			{
				request: { headers: {} },
				logger: { logLevel() {} },
			} as never,
			{ component: "Home", url: "/" },
		);
		const error = (result as { error?: unknown }).error as GlobalError;
		expect(error).toBeInstanceOf(GlobalError);
		expect(error.context.code).toBe(500);
		expect(error.context.json).toMatchObject({ error: "bad render", type: "render" });
	});

	it("6 — honours withoutSsr globs and disableSsr conditions", async () => {
		const ssr = await stub((response) => response.end(JSON.stringify({ head: [], body: "ssr" })));
		configureSsr({ url: ssr.url, ensureBundleExists: false });
		withoutSsr(["admin/*", "dashboard"]);

		await run({ component: "Admin", url: "/admin/x" });
		await run({ component: "Dashboard", url: "/dashboard" });
		await run({ component: "Orders", url: "/orders" });
		disableSsr(() => true);
		await run({ component: "Orders", url: "/orders" });
		expect(ssr.calls).toBe(1);
	});

	it("7 — skips a missing bundle unless ensureBundleExists is false", async () => {
		const ssr = await stub((response) => response.end(JSON.stringify({ head: [], body: "ssr" })));
		configureSsr({ url: ssr.url, bundle: "/definitely/missing/blok-ssr.mjs", ensureBundleExists: true });
		await run({ component: "Home", url: "/" });
		expect(ssr.calls).toBe(0);

		configureSsr({ ensureBundleExists: false });
		await run({ component: "Home", url: "/" });
		expect(ssr.calls).toBe(1);
	});

	it("8 — aborts a hanging render at timeoutMs", async () => {
		const ssr = await stub(() => {});
		configureSsr({ url: ssr.url, ensureBundleExists: false, timeoutMs: 50 });
		const start = performance.now();
		const response = await run({ component: "Home", url: "/" });
		const elapsed = performance.now() - start;

		expect(response.status).toBe(200);
		expect(elapsed).toBeLessThan(100);
	});
});
