import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineNode } from "@blokjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { _resetPageRegistry, always, defer, definePage, merge, optional } from "../src/define-page.js";
import {
	type DevtoolsEntry,
	_resetDevtools,
	configureDevtools,
	defineDevtoolsGate,
	handleDevtoolsRead,
	recordDevtools,
} from "../src/devtools/index.js";
import { type PageObject, renderShell } from "../src/protocol.js";

const page: PageObject = { component: "Orders/Index", props: { orders: [] }, url: "/orders", version: "dev" };
let storage: string;

function pageResponse(value: PageObject = page): Response {
	return Response.json(value, { headers: { "X-Inertia": "true" } });
}

async function record(
	headers: Record<string, string> = { "X-Inertia": "true" },
	response = pageResponse(),
	route = { name: "orders.index", uri: "/orders", action: "orders-index" },
): Promise<{ response: Response; entry: DevtoolsEntry }> {
	const recorded = await recordDevtools({
		request: new Request("http://localhost/orders", { headers }),
		response,
		route,
		serverTimingMs: 12.5,
	});
	const id = recorded.headers.get("x-inertia-devtools-id") as string;
	const read = await handleDevtoolsRead(new Request(`http://localhost/_inertia/devtools/entries/${id}`));
	return { response: recorded, entry: (await read?.json()) as DevtoolsEntry };
}

beforeEach(async () => {
	storage = await mkdtemp(join(tmpdir(), "blok-devtools-"));
	_resetDevtools();
	_resetPageRegistry();
	configureDevtools({ storagePath: storage });
	vi.stubEnv("NODE_ENV", "development");
	vi.stubEnv("BLOK_ENV", "development");
	vi.stubEnv("BLOK_INERTIA_DEVTOOLS_ENABLED", "true");
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(storage, { recursive: true, force: true });
});

describe("Inertia DevTools protocol", () => {
	it("1. emits ULID discovery on every enabled response and the initial HTML tag only when enabled", async () => {
		const initial = await recordDevtools({
			request: new Request("http://localhost/orders"),
			response: new Response(renderShell(page), { headers: { "Content-Type": "text/html" } }),
		});
		expect(initial.headers.get("x-inertia-devtools-id")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(await initial.text()).toContain('<script data-inertia-devtools-id type="application/json">"');

		vi.stubEnv("BLOK_INERTIA_DEVTOOLS_ENABLED", "false");
		const disabled = await recordDevtools({
			request: new Request("http://localhost/orders"),
			response: new Response(renderShell(page), { headers: { "Content-Type": "text/html" } }),
		});
		expect(disabled.headers.get("x-inertia-devtools-id")).toBeNull();
		expect(await disabled.text()).not.toContain("data-inertia-devtools-id");
	});

	it("2. stores correlation headers and emits the flat batch root", async () => {
		const withParent = await record({
			"X-Inertia": "true",
			"X-Inertia-Devtools-Tab": "tab-1",
			"X-Inertia-Devtools-Visit": "visit-1",
			"X-Inertia-Devtools-Parent": "root-1",
		});
		expect(withParent.entry.__meta).toMatchObject({ tabUuid: "tab-1", visitId: "visit-1", batchId: "root-1" });
		expect(withParent.response.headers.get("x-inertia-devtools-parent-out")).toBe("root-1");

		const starter = await record();
		expect(starter.response.headers.get("x-inertia-devtools-parent-out")).toBe(starter.entry.__meta.id);
	});

	it("3. derives request types in the protocol's first-match order", async () => {
		const cases: Array<[Record<string, string>, Response, string]> = [
			[{ Precognition: "true" }, new Response(null, { status: 204 }), "precognition"],
			[{}, new Response(renderShell(page), { headers: { "Content-Type": "text/html" } }), "initial"],
			[{}, Response.json({ ok: true }), "http"],
			[{ "X-Inertia": "true", "X-Inertia-Devtools-Deferred": "1" }, pageResponse(), "deferred"],
			[{ "X-Inertia": "true", "X-Inertia-Devtools-Poll": "1" }, pageResponse(), "poll"],
			[{ "X-Inertia": "true", "X-Inertia-Partial-Component": page.component }, pageResponse(), "partial"],
			[{ "X-Inertia": "true", Purpose: "prefetch" }, pageResponse(), "prefetch"],
			[{ "X-Inertia": "true" }, pageResponse(), "navigate"],
		];
		for (const [headers, response, expected] of cases) {
			const result = await record(headers, response);
			expect(result.entry.__meta.requestType).toBe(expected);
			if (expected === "prefetch") {
				expect(result.response.headers.get("x-inertia-devtools-parent-out")).toBe(result.entry.__meta.id);
			}
		}
	});

	it("4. combines page-registry and wire metadata and redacts props and response headers", async () => {
		const node = defineNode({
			name: "devtools-prop",
			input: z.object({}),
			output: z.object({ value: z.string() }),
			execute: () => ({ value: "ok" }),
		});
		definePage("Orders/Index", {
			auth: always(node),
			stats: defer(node, { group: "g" }),
			rows: merge(node),
			filter: optional(node),
		});

		const client = join(storage, "client");
		await mkdir(join(client, "dist"), { recursive: true });
		await mkdir(join(client, "src", "pages", "Orders"), { recursive: true });
		await writeFile(join(client, "dist", "pages.json"), JSON.stringify({ root: "src/pages", pages: ["Orders/Index"] }));
		await writeFile(join(client, "src", "pages", "Orders", "Index.tsx"), "export default null;\n");
		vi.stubEnv("BLOK_STATIC_DIR", join(client, "dist"));

		const response = pageResponse({
			...page,
			props: { auth: {}, rows: [], filter: "all", shared: true, password: "leak" },
			deferredProps: { g: ["stats"] },
			mergeProps: ["rows"],
			sharedProps: ["shared"],
		});
		response.headers.set("Set-Cookie", "session=secret");
		const { entry } = await record(undefined, response);
		expect(entry.props.auth).toMatchObject({ inertiaType: "always", shared: false });
		expect(entry.props.stats).toMatchObject({ inertiaType: "defer", deferGroup: "g" });
		expect(entry.props.rows).toMatchObject({ inertiaType: "merge", mergeDirection: "append" });
		expect(entry.props.filter).toMatchObject({ inertiaType: "optional" });
		expect(entry.props.shared).toMatchObject({ shared: true });
		expect(entry.propValues.password).toBe("[REDACTED]");
		expect(entry.http.responseHeaders["set-cookie"]).toBe("[REDACTED]");
		expect(entry.componentPath).toMatch(/client\/src\/pages\/Orders\/Index\.tsx$/);
	});

	it("5. omits a non-Inertia JSON response body", async () => {
		const { entry } = await record({}, Response.json({ ok: true }));
		expect(entry.http.responseBody).toEqual({ status: "omitted", reason: "non-inertia-response" });
	});

	it("6. classifies oversized and binary bodies before generic non-Inertia omission", async () => {
		const oversized = await record(
			{},
			new Response("x".repeat(5 * 1024 * 1024), { headers: { "Content-Type": "text/plain" } }),
		);
		expect(oversized.entry.http.responseBody).toEqual({ status: "omitted", reason: "too-large" });
		const binary = await record(
			{},
			new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "application/octet-stream" } }),
		);
		expect(binary.entry.http.responseBody).toEqual({ status: "omitted", reason: "binary" });
	});

	it("7. reads by id, returns 404 for unknown ids, filters types, and lists newest first", async () => {
		const partial = await record({ "X-Inertia": "true", "X-Inertia-Partial-Component": page.component });
		const navigate = await record();
		const missing = await handleDevtoolsRead(
			new Request("http://localhost/_inertia/devtools/entries/01JADEVTOOLS0000000000000"),
		);
		expect(missing?.status).toBe(404);
		const filtered = await handleDevtoolsRead(
			new Request("http://localhost/_inertia/devtools/entries?type=partial&limit=20"),
		);
		expect((await filtered?.json()) as DevtoolsEntry[]).toHaveLength(1);
		const listed = (await (
			await handleDevtoolsRead(new Request("http://localhost/_inertia/devtools/entries?limit=20"))
		)?.json()) as DevtoolsEntry[];
		expect(listed.map((entry) => entry.__meta.id).slice(0, 2)).toEqual([
			navigate.entry.__meta.id,
			partial.entry.__meta.id,
		]);
	});

	it("8. evicts only the oldest entry in a busy tab and prunes entries past TTL", async () => {
		let oldest = "";
		for (let index = 0; index < 201; index++) {
			const result = await record({ "X-Inertia": "true", "X-Inertia-Devtools-Tab": "busy" });
			if (index === 0) oldest = result.entry.__meta.id;
		}
		await record({ "X-Inertia": "true", "X-Inertia-Devtools-Tab": "quiet" });
		const all = (await (
			await handleDevtoolsRead(new Request("http://localhost/_inertia/devtools/entries?limit=500"))
		)?.json()) as DevtoolsEntry[];
		expect(all.filter((entry) => entry.__meta.tabUuid === "busy")).toHaveLength(200);
		expect(all.filter((entry) => entry.__meta.tabUuid === "quiet")).toHaveLength(1);
		expect(
			(await handleDevtoolsRead(new Request(`http://localhost/_inertia/devtools/entries/${oldest}`)))?.status,
		).toBe(404);

		configureDevtools({ ttlMs: 1 });
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
		const pruned = (await (
			await handleDevtoolsRead(new Request("http://localhost/_inertia/devtools/entries?limit=500"))
		)?.json()) as DevtoolsEntry[];
		expect(pruned).toEqual([]);
	});

	it("9. refuses the read API in production unless the named gate allows it", async () => {
		const { entry } = await record();
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("BLOK_ENV", "production");
		const url = `http://localhost/_inertia/devtools/entries/${entry.__meta.id}`;
		expect((await handleDevtoolsRead(new Request(url)))?.status).toBe(403);
		defineDevtoolsGate("broken", () => {
			throw new Error("gate failed");
		});
		vi.stubEnv("BLOK_INERTIA_DEVTOOLS_GATE", "broken");
		expect((await handleDevtoolsRead(new Request(url)))?.status).toBe(403);
		defineDevtoolsGate("admins", () => true);
		vi.stubEnv("BLOK_INERTIA_DEVTOOLS_GATE", "admins");
		expect((await handleDevtoolsRead(new Request(url)))?.status).toBe(200);
	});

	it("10. stores workflow route identity, URI, and source location", async () => {
		const { entry } = await record(undefined, undefined, {
			name: "orders.index",
			uri: "/orders",
			action: "orders-index",
			actionSource: { file: "/app/src/workflows/orders-index.ts", line: 12 },
		});
		expect(entry.route).toMatchObject({ uri: "/orders", action: "orders-index" });
		expect(entry.route.actionSource?.file).toMatch(/workflows\/orders-index\.ts$/);
	});
});
