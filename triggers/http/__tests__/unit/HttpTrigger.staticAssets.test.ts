/**
 * #1000 — SPA static assets, ASSET_VERSION and CORS.
 *
 * Deliberately MOCK-FREE so the exact same file runs under both engines:
 * `vitest run` (Node → `@hono/node-server/serve-static`) and `bun test`
 * (Bun → `hono/bun`). That is the point of the suite — the two `serveStatic`
 * implementations are different code, and only running it twice proves both.
 * `PORT=0` lets each boot take an ephemeral port instead of fighting over 4000.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowRegistry } from "@blokjs/runner";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import HttpTrigger from "../../src/runner/HttpTrigger.js";

const ENV_KEYS = ["BLOK_STATIC_DIR", "ASSET_VERSION", "BLOK_CORS_ORIGIN"] as const;

let staticDir: string;
const running: HttpTrigger[] = [];

/** Boot a real HttpTrigger and hand back its Hono app. */
async function boot(): Promise<ReturnType<HttpTrigger["getApp"]>> {
	WorkflowRegistry.resetInstance();
	const trigger = new HttpTrigger();
	running.push(trigger);
	await trigger.listen();
	return trigger.getApp();
}

beforeAll(() => {
	staticDir = mkdtempSync(join(tmpdir(), "blok-static-"));
	mkdirSync(join(staticDir, "assets"));
	writeFileSync(join(staticDir, "assets", "app-abc123.js"), "export const hello = 1;\n");
	writeFileSync(join(staticDir, "favicon.ico"), "icon");
	writeFileSync(join(staticDir, ".blok-asset-version"), "v1\n");

	process.env.PORT = "0";
	process.env.BLOK_METRICS_DISABLED = "1";
	process.env.BLOK_FILE_BASED_ROUTING = "true";
	process.env.WORKFLOWS_PATH = join(staticDir, "__no_such_workflows_dir__");
	for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(async () => {
	for (const trigger of running.splice(0)) await trigger.stop();
	for (const key of ENV_KEYS) delete process.env[key];
});

afterAll(() => {
	rmSync(staticDir, { recursive: true, force: true });
});

describe("#1000 static assets", () => {
	// Test 1
	it("serves /assets/<file> with an immutable cache header", async () => {
		process.env.BLOK_STATIC_DIR = staticDir;
		const app = await boot();

		const res = await app.request("/assets/app-abc123.js");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("javascript");
		expect(res.headers.get("cache-control")).toContain("immutable");
		expect(res.headers.get("cache-control")).toContain("max-age=31536000");
		expect(await res.text()).toContain("export const hello");
	});

	// Test 2
	it("404s a missing asset instead of the welcome page or a workflow 404", async () => {
		process.env.BLOK_STATIC_DIR = staticDir;
		const app = await boot();

		const res = await app.request("/assets/nope.js");
		expect(res.status).toBe(404);
		const body = await res.text();
		expect(body).toBe("Not Found");
		expect(body).not.toContain("Welcome to blok");
		// A miss must never inherit the year-long cache header.
		expect(res.headers.get("cache-control")).toBeNull();
	});

	// Test 7
	it("404s a traversal out of the static root and never leaks the file", async () => {
		process.env.BLOK_STATIC_DIR = staticDir;
		const app = await boot();

		// Two spellings, two different defences. A `..` SEGMENT (raw or
		// percent-encoded) is collapsed by WHATWG URL normalisation before
		// routing — the request lands on `/package.json` and never sees the
		// static mount at all. `%2F` survives decodeURI, so that one does reach
		// `serveStatic`, as a filename with no such file. Neither returns
		// repo content, which is the property worth pinning.
		for (const attempt of ["/assets/../package.json", "/assets/%2e%2e%2fpackage.json"]) {
			const res = await app.request(attempt);
			expect(res.status).toBe(404);
			expect(await res.text()).not.toContain("@blokjs/trigger-http");
		}
	});

	it("serves favicon.ico from the same root WITHOUT a cache header", async () => {
		process.env.BLOK_STATIC_DIR = staticDir;
		const app = await boot();

		const res = await app.request("/favicon.ico");
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBeNull();
	});

	// Test 3
	it("falls through to the existing not-found behaviour when BLOK_STATIC_DIR is unset", async () => {
		const app = await boot();

		const res = await app.request("/assets/x.js");
		expect(res.status).toBe(404);
		const body = await res.text();
		expect(body).not.toBe("Not Found");
		// The existing shape: the workflow catch-all's JSON 404, naming the
		// unmatched path — NOT the static 404 and NOT the welcome page.
		expect(body.startsWith("{")).toBe(true);
		expect(JSON.parse(body)).toHaveProperty("error");

		// And the welcome page is untouched.
		const home = await app.request("/");
		expect(home.status).toBe(200);
		expect(await home.text()).toContain("Welcome to blok");
	});
});

describe("#1000 ASSET_VERSION", () => {
	// Test 4
	it("reads .blok-asset-version at boot", async () => {
		process.env.BLOK_STATIC_DIR = staticDir;
		await boot();
		expect(process.env.ASSET_VERSION).toBe("v1");
	});

	// Test 4 (override half)
	it("keeps an explicit ASSET_VERSION", async () => {
		process.env.BLOK_STATIC_DIR = staticDir;
		process.env.ASSET_VERSION = "env";
		await boot();
		expect(process.env.ASSET_VERSION).toBe("env");
	});

	it("leaves ASSET_VERSION unset when BLOK_STATIC_DIR is unset", async () => {
		await boot();
		expect(process.env.ASSET_VERSION).toBeUndefined();
	});
});

describe("#1000 CORS", () => {
	// Test 5
	it("answers an Inertia preflight and exposes the Inertia response headers", async () => {
		process.env.BLOK_CORS_ORIGIN = "http://localhost:5173";
		const app = await boot();

		const preflight = await app.request("/orders", {
			method: "OPTIONS",
			headers: {
				Origin: "http://localhost:5173",
				"Access-Control-Request-Method": "POST",
				"Access-Control-Request-Headers": "x-inertia,x-inertia-partial-data",
			},
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
		expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");
		const allowed = (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase();
		expect(allowed).toContain("x-inertia");
		expect(allowed).toContain("x-inertia-partial-data");
		// The ordinary headers must survive the explicit allow-list.
		expect(allowed).toContain("content-type");

		const get = await app.request("/orders", { headers: { Origin: "http://localhost:5173" } });
		const exposed = (get.headers.get("access-control-expose-headers") ?? "").toLowerCase();
		expect(exposed).toContain("x-inertia-location");
		expect(exposed).toContain("x-inertia-version");
		expect(get.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
	});

	it("keeps credentials on with an allow-list of origins", async () => {
		// dev + preview, the other half of standalone mode. Hono echoes the ONE
		// matched origin, so a list is as credential-safe as a single origin.
		process.env.BLOK_CORS_ORIGIN = "http://localhost:5173,http://localhost:4173";
		const app = await boot();

		const res = await app.request("/health-check", { headers: { Origin: "http://localhost:4173" } });
		expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:4173");
		expect(res.headers.get("access-control-allow-credentials")).toBe("true");
	});

	it("does not send credentials with the wildcard origin", async () => {
		process.env.BLOK_CORS_ORIGIN = "*";
		const app = await boot();

		const res = await app.request("/health-check", { headers: { Origin: "http://example.test" } });
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
		expect(res.headers.get("access-control-allow-credentials")).toBeNull();
	});

	// Test 6
	it("emits no Access-Control-* headers when BLOK_CORS_ORIGIN is unset", async () => {
		const app = await boot();

		const res = await app.request("/health-check", { headers: { Origin: "http://localhost:5173" } });
		expect(res.status).toBe(200);
		for (const [name] of res.headers) expect(name.toLowerCase().startsWith("access-control-")).toBe(false);

		const preflight = await app.request("/health-check", {
			method: "OPTIONS",
			headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "POST" },
		});
		for (const [name] of preflight.headers) expect(name.toLowerCase().startsWith("access-control-")).toBe(false);
	});
});
