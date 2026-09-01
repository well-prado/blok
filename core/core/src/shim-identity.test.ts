import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defineNode, step, workflow } from "@blokjs/core";
import { workflow as helperWorkflow } from "@blokjs/helper";
import { RespondNode } from "@blokjs/helpers";
import { applyStepOutput } from "@blokjs/runner/workflow/PersistenceHelper";
import { normalizeWorkflow } from "@blokjs/runner/workflow/WorkflowNormalizer";
import { type Context, RESPOND_BRAND, isRespondEnvelope, mapper } from "@blokjs/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { emitWorkflowResponse } from "../../../triggers/http/src/runner/responseEmitter";

const require = createRequire(import.meta.url);

type HelperPublic = typeof import("@blokjs/helper");

const EchoNode = defineNode({
	name: "test-shim-echo",
	description: "test-local node for shim identity checks",
	input: z.object({
		body: z.unknown(),
		seed: z.unknown(),
	}),
	output: z.object({
		body: z.unknown(),
		seed: z.unknown(),
	}),
	execute: (_ctx, input) => input,
});

async function importSecondHelperInstance(): Promise<{
	helper: HelperPublic;
	dispose: () => Promise<void>;
}> {
	const indexPath = require.resolve("@blokjs/helper");
	const distDir = path.dirname(indexPath);
	const packageDir = path.dirname(distDir);
	const tmp = await mkdtemp(path.join(tmpdir(), "blok-helper-skew-"));
	const copyDir = path.join(tmp, "helper-dist");
	await cp(distDir, copyDir, { recursive: true });
	await cp(path.join(packageDir, "src"), path.join(tmp, "src"), { recursive: true });

	// The copied helper remains a separate module instance, but it still needs
	// the runtime dependencies that a package manager installs beside it.
	const sharedIndexPath = require.resolve("@blokjs/shared");
	const sharedPackageDir = path.dirname(path.dirname(sharedIndexPath));
	const dependencyScope = path.join(tmp, "node_modules", "@blokjs");
	await mkdir(dependencyScope, { recursive: true });
	await symlink(sharedPackageDir, path.join(dependencyScope, "shared"), "dir");

	const nonce = `?v=${Date.now()}-${Math.random()}`;
	const helper = (await import(pathToFileURL(path.join(copyDir, "index.js")).href + nonce)) as HelperPublic;

	return {
		helper,
		dispose: () => rm(tmp, { recursive: true, force: true }),
	};
}

function ctxFor(body: unknown = { message: "hello" }): Context {
	const state: Record<string, unknown> = { seed: { value: 7 } };
	const ctx = {
		id: "req-shim",
		workflow_name: "shim-identity",
		workflow_path: "/shim",
		request: { body, headers: {}, params: {}, query: {} },
		response: { data: null, success: true, error: null, contentType: "application/json" },
		error: { message: [] },
		logger: {
			log: () => {},
			logLevel: () => {},
			error: () => {},
			getLogs: () => [],
			getLogsAsText: () => "",
			getLogsAsBase64: () => "",
		},
		config: {},
		vars: state,
		state,
		env: {},
		eventLogger: null,
		_PRIVATE_: null,
	} as unknown as Context;

	Object.defineProperty(ctx, "req", {
		get: () => ctx.request,
	});
	Object.defineProperty(ctx, "prev", {
		get: () => ctx.response,
	});

	return ctx;
}

async function emit(ctxResponse: unknown): Promise<Response> {
	const app = new Hono();
	app.get("/x", (c) => emitWorkflowResponse(c, ctxResponse));
	return app.request("/x");
}

describe("shim identity across core/helper version skew", () => {
	it("keeps helper and core workflow envelopes structural across import boundaries", async () => {
		const skew = await importSecondHelperInstance();
		try {
			const shimWorkflow = skew.helper.workflow({
				name: "Shim Workflow",
				version: "1.0.0",
				trigger: { http: { method: "POST" } },
				steps: [{ id: "out", use: "@blokjs/respond", inputs: { body: "js/ctx.req.body" } }],
			});
			expect(shimWorkflow._blokV2).toBe(true);
			expect(shimWorkflow._config.steps[0]?.inputs?.body).toBe("js/ctx.req.body");
			expect(normalizeWorkflow(shimWorkflow).steps[0]?.name).toBe("out");

			const coreWorkflow = await workflow(
				"Core Workflow",
				{ version: "1.0.0", trigger: { http: { method: "POST" } } },
				() => {
					step("echo", EchoNode, {
						body: "js/ctx.req.body",
						seed: "js/ctx.state.seed.value",
					});
				},
			);
			expect(coreWorkflow._blokV2).toBe(true);
			const inputs = coreWorkflow._config.steps[0]?.inputs as Record<string, unknown>;
			expect(inputs.body).toBe("js/ctx.req.body");
			expect(inputs.seed).toBe("js/ctx.state.seed.value");
		} finally {
			await skew.dispose();
		}
	});

	it("runs skewed core workflow inputs through mapper and persistence", async () => {
		const skew = await importSecondHelperInstance();
		try {
			const built = await workflow(
				"Mapper Persistence",
				{ version: "1.0.0", trigger: { http: { method: "POST" } } },
				() => {
					step(
						"echo",
						EchoNode,
						{
							body: "js/ctx.req.body",
							seed: "js/ctx.state.seed.value",
						},
						{ as: "result" },
					);
				},
			);

			const inputs = structuredClone(built._config.steps[0]?.inputs ?? {}) as Record<string, string>;
			const ctx = ctxFor({ message: "from-skew" });
			mapper.replaceObjectStrings(inputs, ctx, {});

			expect(inputs).toEqual({ body: { message: "from-skew" }, seed: 7 });
			applyStepOutput(ctx, { name: "echo", as: "result" }, { data: inputs });
			expect(ctx.state?.result).toEqual({ body: { message: "from-skew" }, seed: 7 });
		} finally {
			await skew.dispose();
		}
	});

	it("recognizes @blokjs/respond envelopes created across the shim/core boundary", async () => {
		const response = await RespondNode.handle(ctxFor(), {
			body: { ok: true },
			status: 202,
			contentType: "application/json",
			headers: { "X-Blok-Test": "shim" },
		});
		const envelope = (response as { data: Record<string, unknown> }).data;

		expect(envelope[RESPOND_BRAND]).toBe(true);
		expect(isRespondEnvelope(envelope)).toBe(true);

		const res = await emit({ data: envelope, contentType: "application/json", success: true, error: null });
		expect(res.status).toBe(202);
		expect(res.headers.get("X-Blok-Test")).toBe("shim");
		expect(await res.json()).toEqual({ ok: true });
	});

	it("accepts the workspace helper workflow as the same structural v2 envelope", () => {
		const wf = helperWorkflow({
			name: "Workspace Helper",
			version: "1.0.0",
			trigger: { http: { method: "GET" } },
			steps: [{ id: "out", use: "@blokjs/respond", inputs: { body: "js/ctx.state.seed" } }],
		});
		expect(wf._blokV2).toBe(true);
		expect(normalizeWorkflow(wf).steps[0]?.name).toBe("out");
	});
});
