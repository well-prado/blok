/**
 * #1016 — multipart uploads and `_method` spoofing, driven through the real
 * Hono app with real `FormData` / `File` bodies (`app.request`).
 *
 * Same harness as `HttpTrigger.inputValidation.test.ts`: mock the OTel /
 * metrics / server surface, extend `../../src/Nodes` with two probe nodes (one
 * that reports what a file part looked like INSIDE the step, one that records
 * middleware-chain execution), and mock `../../src/Workflows` with the route
 * fixtures.
 */

import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { makeOtelApiMock } = await vi.hoisted(() => import("../helpers/otel-api-mock.js"));
vi.mock("@opentelemetry/api", () => makeOtelApiMock());

vi.mock("../../src/runner/metrics/opentelemetry_metrics", () => ({
	bootstrapMetrics: async () => ({ meter: {}, metricsHandler: () => {} }),
	resetBootstrap: () => {},
	metricsHandler: vi.fn(),
}));
vi.mock("../../src/AppRoutes", () => {
	const { Hono } = require("hono");
	return { default: new Hono() };
});

/** Cross-boundary recorder: filled by the probe nodes, read by the tests. */
const probe = vi.hoisted(() => ({
	middleware: [] as string[],
	spoolPath: undefined as string | undefined,
	ran: [] as string[],
	report: undefined as Record<string, unknown> | undefined,
}));

vi.mock("../../src/Nodes", async (importActual) => {
	const actual = (await importActual()) as { default: Record<string, unknown> };
	const { defineNode } = await import("@blokjs/runner");
	const { z } = await import("zod");
	const { existsSync: exists } = await import("node:fs");

	const uploadProbe = defineNode({
		name: "test/upload-probe",
		description: "Reports what a multipart file part looks like inside a step.",
		input: z.object({ workflow: z.string(), file: z.unknown().optional() }),
		output: z.object({
			workflow: z.string(),
			isFile: z.boolean(),
			name: z.string().optional(),
			size: z.number().optional(),
			type: z.string().optional(),
			spooled: z.boolean(),
			tempFileExists: z.boolean(),
			text: z.string().optional(),
		}),
		async execute(_ctx, input) {
			probe.ran.push(input.workflow);
			const file = input.file;
			if (!(file instanceof File)) {
				return { workflow: input.workflow, isFile: false, spooled: false, tempFileExists: false };
			}
			const spoolPath = (file as File & { path?: string }).path;
			probe.spoolPath = spoolPath;
			const report = {
				workflow: input.workflow,
				isFile: true,
				name: file.name,
				size: file.size,
				type: file.type,
				spooled: typeof spoolPath === "string",
				tempFileExists: typeof spoolPath === "string" ? exists(spoolPath) : false,
				...(file.size <= 64 ? { text: await file.text() } : {}),
			};
			probe.report = report;
			return report;
		},
	});

	const middlewareProbe = defineNode({
		name: "test/mw-probe",
		description: "Records that a middleware chain ran.",
		input: z.object({ tag: z.string() }),
		output: z.object({ tag: z.string() }),
		async execute(_ctx, input) {
			probe.middleware.push(input.tag);
			return { tag: input.tag };
		},
	});

	return { default: { ...actual.default, "test/upload-probe": uploadProbe, "test/mw-probe": middlewareProbe } };
});

vi.mock("../../src/Workflows", () => {
	const ref = (...path: string[]) => ({ $ref: { step: "@trigger", path } });
	/** Echo what the workflow saw: which one ran, the body, both methods. */
	const echo = (name: string) => ({
		id: "out",
		use: "@blokjs/respond",
		inputs: {
			body: {
				ran: name,
				body: ref("body"),
				method: ref("method"),
				originalMethod: ref("originalMethod"),
			},
		},
	});
	const mw = (tag: string) => ({
		_blokV2: true,
		_config: {
			name: `mw-${tag}`,
			version: "1.0.0",
			middleware: true,
			trigger: {},
			steps: [{ id: "mark", use: "test/mw-probe", inputs: { tag } }],
		},
	});
	const wf = (name: string, method: string, path: string, steps: unknown[], middleware?: string[]) => ({
		_blokV2: true,
		_config: {
			name,
			version: "1.0.0",
			trigger: { http: { method, path, ...(middleware ? { middleware } : {}) } },
			steps,
		},
	});

	return {
		default: {
			"mw-put": mw("put"),
			"mw-post": mw("post"),
			// Same path, three methods — routing has to pick by EFFECTIVE method.
			"orders-update": wf(
				"orders-update",
				"PUT",
				"/orders/:id",
				[
					{ id: "probe", use: "test/upload-probe", inputs: { workflow: "orders-update", file: ref("body", "avatar") } },
					echo("orders-update"),
				],
				["mw-put"],
			),
			"orders-create": wf("orders-create", "POST", "/orders/:id", [echo("orders-create")], ["mw-post"]),
			"orders-delete": wf("orders-delete", "DELETE", "/orders/:id", [echo("orders-delete")]),
			// PATCH-only path: a spoofed POST must still reach it.
			"profile-patch": wf("profile-patch", "PATCH", "/profile", [echo("profile-patch")]),
			// PUT-only path used by the upload limit / spool tests.
			"avatar-put": wf("avatar-put", "PUT", "/avatar", [
				{ id: "probe", use: "test/upload-probe", inputs: { workflow: "avatar-put", file: ref("body", "avatar") } },
				echo("avatar-put"),
			]),
		},
	};
});

const mockServer = { close: vi.fn(), on: vi.fn() };
vi.mock("@hono/node-server", () => ({
	serve: vi.fn((_opts: unknown, cb?: () => void) => {
		cb?.();
		return mockServer;
	}),
}));
vi.mock("@hono/node-server/serve-static", () => ({ serveStatic: () => vi.fn() }));
vi.mock("@hono/node-server/utils/response", () => ({ RESPONSE_ALREADY_SENT: new Response(null) }));

import { WorkflowRegistry } from "@blokjs/runner";
import HttpTrigger from "../../src/runner/HttpTrigger.js";

type Echoed = {
	ran?: string;
	body?: Record<string, unknown>;
	method?: string;
	originalMethod?: string;
};

async function boot(): Promise<HttpTrigger> {
	const trigger = new HttpTrigger();
	await trigger.listen();
	return trigger;
}

/** Drive the real app with a real request. */
async function send(path: string, init: RequestInit): Promise<Response> {
	const trigger = await boot();
	return trigger.getApp().request(path, init);
}

function upload(
	fields: Record<string, string>,
	file?: { field: string; bytes: Uint8Array; name: string; type?: string },
): FormData {
	const form = new FormData();
	for (const [k, v] of Object.entries(fields)) form.set(k, v);
	if (file) form.set(file.field, new File([file.bytes], file.name, { type: file.type ?? "application/octet-stream" }));
	return form;
}

const ENV_KEYS = ["BLOK_MAX_UPLOAD_BYTES", "BLOK_UPLOAD_SPOOL_BYTES", "BLOK_METHOD_SPOOFING"] as const;

describe("HttpTrigger — multipart uploads and `_method` spoofing (#1016)", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
		process.env.WORKFLOWS_PATH = "/tmp/__blok_no_such_workflows_dir__";
		process.env.BLOK_FILE_BASED_ROUTING = "true";
		probe.middleware.length = 0;
		probe.ran.length = 0;
		probe.spoolPath = undefined;
		probe.report = undefined;
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
	});

	// Test 1
	it("routes a multipart POST with `_method=put` to the PUT workflow, strips `_method`, keeps originalMethod", async () => {
		const res = await send("/orders/1", {
			method: "POST",
			body: upload(
				{ _method: "put", name: "ada" },
				{ field: "avatar", bytes: new Uint8Array([1, 2, 3]), name: "a.png", type: "image/png" },
			),
		});

		expect(res.status).toBe(200);
		const json = (await res.json()) as Echoed;
		expect(json.ran).toBe("orders-update");
		expect(json.method).toBe("PUT");
		expect(json.originalMethod).toBe("POST");
		expect(json.body).toHaveProperty("name", "ada");
		expect(json.body).toHaveProperty("avatar");
		expect(json.body).not.toHaveProperty("_method");
	});

	// Test 1 (cont.) — the file reaches the step as a real File.
	it("hands the file part to the node as a File object", async () => {
		const res = await send("/orders/2", {
			method: "POST",
			body: upload(
				{ _method: "put" },
				{ field: "avatar", bytes: new TextEncoder().encode("hello"), name: "a.txt", type: "text/plain" },
			),
		});

		expect(res.status).toBe(200);
		expect(probe.ran).toContain("orders-update");
	});

	// Test 2
	it("accepts an uppercase `_method=DELETE`", async () => {
		const res = await send("/orders/3", { method: "POST", body: upload({ _method: "DELETE" }) });

		const json = (await res.json()) as Echoed;
		expect(json.ran).toBe("orders-delete");
		expect(json.method).toBe("DELETE");
		expect(json.originalMethod).toBe("POST");
	});

	// Test 3
	it("ignores a non-spoofable `_method=get` — the POST workflow runs", async () => {
		const res = await send("/orders/4", { method: "POST", body: upload({ _method: "get" }) });

		const json = (await res.json()) as Echoed;
		expect(json.ran).toBe("orders-create");
		expect(json.method).toBe("POST");
		expect(json.body).toHaveProperty("_method", "get");
	});

	// Test 4
	it("ignores `_method` on a PUT — spoofing is POST-only", async () => {
		const res = await send("/orders/5", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ _method: "delete" }),
		});

		const json = (await res.json()) as Echoed;
		expect(json.ran).toBe("orders-update");
		expect(json.method).toBe("PUT");
		expect(json.body).toHaveProperty("_method", "delete");
	});

	// Test 5
	it("rejects an over-limit upload with 413 before the workflow runs", async () => {
		process.env.BLOK_MAX_UPLOAD_BYTES = String(1024 * 1024);
		const res = await send("/avatar", {
			method: "POST",
			body: upload({ _method: "put" }, { field: "avatar", bytes: new Uint8Array(4 * 1024 * 1024), name: "big.bin" }),
		});

		expect(res.status).toBe(413);
		const json = (await res.json()) as { error?: string; maxBytes?: number; configurable?: string };
		expect(json.error).toBe("Payload too large");
		expect(json.maxBytes).toBe(1024 * 1024);
		expect(json.configurable).toBe("BLOK_MAX_UPLOAD_BYTES");
		// Nothing ran.
		expect(probe.ran).toEqual([]);
	});

	// Test 6
	it("spools a file past the threshold to disk and removes the temp file after the run", async () => {
		process.env.BLOK_UPLOAD_SPOOL_BYTES = String(64 * 1024);
		const res = await send("/avatar", {
			method: "POST",
			body: upload(
				{ _method: "put" },
				{ field: "avatar", bytes: new Uint8Array(2 * 1024 * 1024).fill(7), name: "big.bin" },
			),
		});

		expect(res.status).toBe(200);
		const json = (await res.json()) as Echoed;
		expect(json.ran).toBe("avatar-put");
		expect(json.body).toHaveProperty("avatar");
		// Asserted INSIDE the step (see `probeReport`): the part was spooled to a
		// temp file that existed while the step ran.
		expect(probe.spoolPath).toBeTypeOf("string");
		expect(probe.report).toMatchObject({ isFile: true, spooled: true, tempFileExists: true, size: 2 * 1024 * 1024 });
		// …and gone once the response is out.
		expect(existsSync(probe.spoolPath as string)).toBe(false);
	});

	// Test 7
	it('spoofs from a JSON body — `{"_method":"patch"}` reaches the PATCH workflow', async () => {
		const res = await send("/profile", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ _method: "patch", nickname: "ada" }),
		});

		const json = (await res.json()) as Echoed;
		expect(json.ran).toBe("profile-patch");
		expect(json.method).toBe("PATCH");
		expect(json.originalMethod).toBe("POST");
		expect(json.body).toEqual({ nickname: "ada" });
	});

	// Test 7 (cont.) — urlencoded bodies spoof the same way.
	it("spoofs from an urlencoded body", async () => {
		const res = await send("/orders/6", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "_method=DELETE&id=6",
		});

		const json = (await res.json()) as Echoed;
		expect(json.ran).toBe("orders-delete");
		expect(json.body).toEqual({ id: "6" });
	});

	// Test 8
	it("runs the spoofed workflow's middleware chain, not the POST workflow's", async () => {
		const res = await send("/orders/7", { method: "POST", body: upload({ _method: "put" }) });

		expect(res.status).toBe(200);
		expect(probe.middleware).toEqual(["put"]);
	});

	it("runs the POST workflow's chain when nothing is spoofed", async () => {
		const res = await send("/orders/8", { method: "POST", body: upload({ hello: "world" }) });

		expect(res.status).toBe(200);
		expect(probe.middleware).toEqual(["post"]);
	});

	// Test 9 (the Playwright case, as an `app.request`): the stock Inertia client
	// posts `useForm({ avatar: File }).post(url, { _method: "put" })` — a
	// multipart POST carrying `_method` plus a real file.
	it("handles the Inertia client shape: multipart POST + `_method=put` + File on a PUT-only path", async () => {
		const form = new FormData();
		form.set("_method", "put");
		form.set("avatar", new File([new TextEncoder().encode("avatar-bytes")], "me.png", { type: "image/png" }));
		const res = await send("/avatar", { method: "POST", body: form });

		expect(res.status).toBe(200);
		const json = (await res.json()) as Echoed;
		expect(json.ran).toBe("avatar-put");
		expect(json.method).toBe("PUT");
		expect(json.originalMethod).toBe("POST");
		expect(json.body).not.toHaveProperty("_method");
		expect(probe.ran).toEqual(["avatar-put"]);
	});

	it("honours BLOK_METHOD_SPOOFING=0 — the POST workflow runs and `_method` stays", async () => {
		process.env.BLOK_METHOD_SPOOFING = "0";
		const res = await send("/orders/9", { method: "POST", body: upload({ _method: "put" }) });

		const json = (await res.json()) as Echoed;
		expect(json.ran).toBe("orders-create");
		expect(json.method).toBe("POST");
		expect(json.body).toHaveProperty("_method", "put");
	});

	it("404s a spoof-only POST when nothing is registered for the spoofed method", async () => {
		process.env.BLOK_METHOD_SPOOFING = "0";
		const res = await send("/avatar", { method: "POST", body: upload({ _method: "put" }) });

		expect(res.status).toBe(404);
		expect(probe.ran).toEqual([]);
	});
});
