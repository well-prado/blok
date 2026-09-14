import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteEntry } from "../../src/runner/WorkflowRouter.js";
import { inertiaDevtools } from "../../src/runner/inertiaDevtools.js";

let storage: string;

beforeEach(async () => {
	storage = await mkdtemp(join(tmpdir(), "blok-http-devtools-"));
	vi.stubEnv("NODE_ENV", "development");
	vi.stubEnv("BLOK_ENV", "development");
	vi.stubEnv("BLOK_INERTIA_DEVTOOLS_ENABLED", "true");
	vi.stubEnv("BLOK_INERTIA_DEVTOOLS_PATH", storage);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(storage, { recursive: true, force: true });
});

describe("inertiaDevtools HTTP hook", () => {
	it("records an initial response with discovery and matched workflow metadata", async () => {
		const route: RouteEntry = {
			method: "GET",
			path: "/orders",
			workflowKey: "orders",
			source: "/app/src/workflows/orders-index.ts",
			sourcePath: "/app/src/workflows/orders-index.ts",
			kind: "ts",
			workflow: { name: "orders-index" },
		};
		const page = { component: "Orders/Index", props: {}, url: "/orders", version: "dev" };
		const app = new Hono();
		app.use(
			"*",
			inertiaDevtools(() => [route]),
		);
		app.get("/orders", (c) =>
			c.html(
				`<html><body><script type="application/json" data-page="app">${JSON.stringify(page)}</script></body></html>`,
			),
		);

		const response = await app.request("http://localhost/orders");
		const id = response.headers.get("x-inertia-devtools-id");
		expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(await response.text()).toContain("data-inertia-devtools-id");
		const entry = await app.request(`http://localhost/_inertia/devtools/entries/${id}`);
		expect(entry.status).toBe(200);
		expect((await entry.json()).route).toMatchObject({ uri: "/orders", action: "orders-index" });
	});
});
