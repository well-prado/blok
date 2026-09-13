import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineNode } from "@blokjs/runner/defineNode";
import { GlobalError } from "@blokjs/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveBlobDir, resolveClaimCheck } from "../src/claimCheck.js";
import { WorkerError, toNodeError } from "../src/errors.js";
import {
	MIN_ENGINE_VERSIONS,
	buildRuntimeCapabilityManifest,
	detectHostRuntime,
	runtimeKindOf,
	sdkNameOf,
} from "../src/host.js";
import { declaredEffects, denoPermissionFlags, denoPermissionGrants, parseNetAllowList } from "../src/permissions.js";
import {
	type ExecuteContextProjection,
	type WorkerNode,
	WorkerRegistry,
	isRuntimeCompatible,
} from "../src/registry.js";
import { ConcurrencyGate } from "../src/server.js";

const ORIGIN = { node: "n", sdk: "blok-js-node", sdkVersion: "1.0.0", runtimeKind: "runtime.nodejs" };

function projection(inputs: unknown, signal = new AbortController().signal): ExecuteContextProjection {
	return {
		inputs,
		stepName: "s1",
		request: {
			body: {},
			headers: {},
			params: {},
			query: {},
			cookies: {},
			method: "POST",
			url: "/",
			baseUrl: "",
		} as never,
		env: { SAFE: "yes" },
		runId: "run-1",
		workflowName: "wf",
		workflowPath: "/wf",
		signal,
	};
}

const echo = defineNode({
	name: "echo",
	description: "Echoes its input.",
	input: z.object({ value: z.string() }),
	output: z.object({ value: z.string(), sawState: z.boolean(), env: z.string() }),
	execute: (ctx, input) => {
		ctx.logger.log("echoing");
		ctx.publish?.("published", input.value);
		return {
			value: input.value,
			// The worker must not ship accumulated workflow state across the
			// boundary; a node therefore sees an EMPTY state object.
			sawState: Object.keys((ctx.state ?? {}) as Record<string, unknown>).length > 0,
			env: String((ctx.env as Record<string, string> | undefined)?.SAFE ?? ""),
		};
	},
}) as unknown as WorkerNode;

const explodes = defineNode({
	name: "explodes",
	description: "Always throws.",
	input: z.object({}).passthrough(),
	output: z.object({}).passthrough(),
	execute: () => {
		throw new Error("boom");
	},
}) as unknown as WorkerNode;

const cancellable = defineNode({
	name: "cancellable",
	description: "Waits until cancelled.",
	input: z.object({}).passthrough(),
	output: z.object({ aborted: z.boolean() }),
	execute: async (ctx) => {
		await new Promise<void>((resolve) => {
			if (ctx.signal?.aborted) return resolve();
			ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
		});
		return { aborted: ctx.signal?.aborted === true };
	},
}) as unknown as WorkerNode;

function registryWith(...nodes: WorkerNode[]): WorkerRegistry {
	const registry = new WorkerRegistry();
	for (const node of nodes) registry.register(node);
	return registry;
}

describe("host + capability manifest", () => {
	it("reports the engine actually executing this process", () => {
		const runtime = detectHostRuntime();
		expect(["node", "bun", "deno"]).toContain(runtime);
		expect(sdkNameOf(runtime)).toBe(`blok-js-${runtime}`);
		expect(runtimeKindOf(runtime)).toBe(runtime === "node" ? "nodejs" : runtime);
	});

	it("builds a schema-valid runtime capability manifest", () => {
		const manifest = buildRuntimeCapabilityManifest({ maxMessageBytes: 1024 });
		expect(manifest.protocolVersion).toBe("1.0.0");
		expect(manifest.moduleFormats).toContain("esm");
		expect(manifest.cancellation).toBe(true);
		expect(manifest.streaming).toBe(true);
		expect(manifest.maxMessageBytes).toBe(1024);
	});
});

describe("engine floors", () => {
	// The floor only means something if the thing that PROVES it runs on it.
	// CI pins a Deno version explicitly (never "latest"), so a floor bump that
	// forgets the pin would leave the new floor unproven — and a pin bump that
	// forgets the floor would quietly raise the real requirement.
	it("keeps every CI Deno pin equal to the declared floor", () => {
		const workflow = fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url));
		if (!existsSync(workflow)) return; // not a repo checkout (packed consumer)
		const pins = [...readFileSync(workflow, "utf8").matchAll(/deno-version:\s*v?([\d.]+)/g)].map((m) => m[1]);
		expect(pins.length).toBeGreaterThan(0);
		for (const pin of pins) expect(pin).toBe(MIN_ENGINE_VERSIONS.deno);
	});

	it("declares the versions the worker is actually proven against", () => {
		// 2.7.4 fails the integration suite, 2.7.5 passes: below 2.7.5 Deno's
		// Node-compat HTTP/2 server binds the port and never completes a call.
		expect(MIN_ENGINE_VERSIONS).toEqual({ node: "20.0.0", bun: "1.1.0", deno: "2.7.5" });
	});
});

describe("registry execution", () => {
	it("validates input with Zod and returns the typed output", async () => {
		const out = await registryWith(echo).execute("echo", projection({ value: "hi" }));
		expect(out.success).toBe(true);
		expect(out.data).toMatchObject({ value: "hi", sawState: false, env: "yes" });
	});

	it("projects logs and ctx.publish writes back, not accumulated state", async () => {
		const out = await registryWith(echo).execute("echo", projection({ value: "hi" }));
		expect(out.logs.map((l) => l.message)).toContain("echoing");
		expect(out.varsDelta).toEqual({ published: "hi" });
	});

	it("turns a Zod failure into a VALIDATION envelope with the issue detail", async () => {
		const out = await registryWith(echo).execute("echo", projection({ value: 42 }));
		expect(out.success).toBe(false);
		const envelope = toNodeError(out.error, ORIGIN);
		expect(envelope.category).toBe("VALIDATION");
		expect(envelope.httpStatus).toBe(400);
		expect(envelope.code).toBe("NODE_INPUT_VALIDATION_FAILED");
		expect(JSON.parse(envelope.detailsJson.toString("utf8"))).toHaveProperty("validation_errors");
	});

	it("turns a thrown error into an INTERNAL envelope carrying the stack", async () => {
		const out = await registryWith(explodes).execute("explodes", projection({}));
		expect(out.success).toBe(false);
		const envelope = toNodeError(out.error, ORIGIN);
		expect(envelope.message).toContain("boom");
		expect(envelope.httpStatus).toBe(500);
		expect(envelope.stack.length).toBeGreaterThan(0);
		expect(envelope.runtimeKind).toBe("runtime.nodejs");
		expect(envelope.sdk).toBe("blok-js-node");
	});

	it("fails closed on an unregistered node", async () => {
		await expect(registryWith(echo).execute("nope", projection({}))).rejects.toMatchObject({
			code: "NODE_NOT_FOUND",
		});
	});

	it("propagates cancellation through ctx.signal", async () => {
		const controller = new AbortController();
		const pending = registryWith(cancellable).execute("cancellable", projection({}, controller.signal));
		controller.abort();
		await expect(pending).resolves.toMatchObject({ success: true, data: { aborted: true } });
	});

	it("counts executions on the process so worker reuse is observable", async () => {
		const registry = registryWith(echo);
		await registry.execute("echo", projection({ value: "a" }));
		await registry.execute("echo", projection({ value: "b" }));
		expect(registry.executions).toBe(2);
	});

	it("reflects real JSON Schema and the capability manifest into descriptors", () => {
		const [descriptor] = registryWith(echo).descriptors();
		expect(JSON.stringify(descriptor.inputSchema)).toContain("value");
		expect(descriptor.description).toBe("Echoes its input.");
	});
});

describe("error envelope", () => {
	it("keeps a WorkerError's own classification", () => {
		const envelope = toNodeError(new WorkerError("X", "nope", "RATE_LIMIT", 503, true, "slow down"), ORIGIN);
		expect(envelope).toMatchObject({ code: "X", category: "RATE_LIMIT", httpStatus: 503, retryable: true });
		expect(envelope.remediation).toBe("slow down");
	});

	it("maps a GlobalError's HTTP code to a proto category", () => {
		const err = new GlobalError("nope");
		err.setCode(404);
		expect(toNodeError(err, ORIGIN).category).toBe("NOT_FOUND");
	});

	it("never loses a non-Error throw", () => {
		expect(toNodeError("plain string", ORIGIN)).toMatchObject({ message: "plain string", category: "INTERNAL" });
	});
});

describe("claim-check (blob-v1)", () => {
	let dir = "";
	beforeAll(() => {
		dir = mkdtempSync(path.join(tmpdir(), "blok-blob-"));
		mkdirSync(path.join(dir, "run-1"), { recursive: true });
		writeFileSync(path.join(dir, "run-1", "payload.json"), JSON.stringify({ name: "Ada" }));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("advertises nothing when BLOK_BLOB_DIR is unset or unreadable", () => {
		expect(resolveBlobDir({})).toBeNull();
		expect(resolveBlobDir({ BLOK_BLOB_DIR: path.join(dir, "missing") })).toBeNull();
		expect(resolveBlobDir({ BLOK_BLOB_DIR: dir })).toBe(dir);
	});

	it("resolves a sentinel to the referenced payload", () => {
		const ref = { $blokBlob: { id: "run-1/payload.json", bytes: 20, codec: "json" } };
		expect(resolveClaimCheck(ref, dir, 1024)).toEqual({ name: "Ada" });
	});

	it("passes non-sentinel values through untouched", () => {
		expect(resolveClaimCheck({ name: "Ada" }, dir, 1024)).toEqual({ name: "Ada" });
	});

	it("refuses a path-traversing id instead of reading outside the blob dir", () => {
		const ref = { $blokBlob: { id: "../../etc/passwd", bytes: 10, codec: "json" } };
		// Not a valid sentinel at all — it never reaches the filesystem.
		expect(resolveClaimCheck(ref, dir, 1024)).toBe(ref);
	});

	it("refuses a blob larger than the message ceiling", () => {
		const ref = { $blokBlob: { id: "run-1/payload.json", bytes: 10_000, codec: "json" } };
		expect(() => resolveClaimCheck(ref, dir, 1024)).toThrow(/BLOB_TOO_LARGE|over this worker/);
	});

	it("reports a missing blob as a retryable dependency failure", () => {
		const ref = { $blokBlob: { id: "run-1/gone.json", bytes: 10, codec: "json" } };
		expect(() => resolveClaimCheck(ref, dir, 1024)).toThrow(/not present under BLOK_BLOB_DIR/);
	});
});

describe("bounded concurrency", () => {
	it("queues up to the limit and then rejects deterministically", async () => {
		const gate = new ConcurrencyGate(1, 1);
		await gate.acquire(); // in flight
		const queued = gate.acquire(); // queued
		await expect(gate.acquire()).rejects.toMatchObject({ code: "WORKER_OVERLOADED", httpStatus: 503 });
		gate.release();
		await queued;
		expect(gate.inFlight).toBe(1);
	});

	it("hands the slot to the next waiter on release", async () => {
		const gate = new ConcurrencyGate(1, 4);
		await gate.acquire();
		let granted = false;
		const queued = gate.acquire().then(() => {
			granted = true;
		});
		expect(granted).toBe(false);
		gate.release();
		await queued;
		expect(granted).toBe(true);
	});
});

describe("runtime constraints", () => {
	it("treats an absent or empty declaration as portable", () => {
		expect(isRuntimeCompatible([], "deno")).toBe(true);
	});

	it("accepts the canonical kind, the runtime. prefix, and the legacy aliases", () => {
		for (const declared of [["nodejs"], ["runtime.nodejs"], ["node"], ["typescript"], ["ts"], ["NodeJS"]]) {
			expect(isRuntimeCompatible(declared, "nodejs"), declared.join()).toBe(true);
		}
	});

	it("refuses an engine the node never named", () => {
		expect(isRuntimeCompatible(["bun"], "deno")).toBe(false);
		expect(isRuntimeCompatible(["bun", "deno"], "nodejs")).toBe(false);
		// Multi-engine declarations are satisfied by any one of them.
		expect(isRuntimeCompatible(["bun", "deno"], "deno")).toBe(true);
	});
});

describe("deno permissions", () => {
	const options = { port: 10014, projectRoot: "/srv/app" };

	it("grants only the baseline when nodes declare no effects", () => {
		expect(denoPermissionFlags([], options)).toEqual([
			"--allow-net=127.0.0.1:10014,localhost:10014",
			"--allow-read=/srv/app",
			"--allow-env",
		]);
	});

	it("widens net only for a declared network effect", () => {
		expect(denoPermissionFlags(["network"], options)[0]).toBe("--allow-net");
	});

	it("grants write and run only for declared filesystem/process effects", () => {
		expect(denoPermissionFlags(["filesystem", "process"], options)).toContain("--allow-write=/srv/app");
		expect(denoPermissionFlags(["filesystem", "process"], options)).toContain("--allow-run");
		expect(denoPermissionFlags(["read"], options)).not.toContain("--allow-run");
	});

	it("reaches --allow-all only through the explicit opt-in", () => {
		expect(denoPermissionFlags(["network"], { ...options, allowAll: true })).toEqual(["--allow-all"]);
	});

	it("scopes the network grant when the operator supplies an allow-list", () => {
		const netAllow = parseNetAllowList("api.example.com, db.internal:5432 ,");
		expect(netAllow).toEqual(["api.example.com", "db.internal:5432"]);
		expect(denoPermissionFlags(["network"], { ...options, netAllow })[0]).toBe(
			"--allow-net=api.example.com,db.internal:5432",
		);
		// An empty/whitespace-only value must not silently produce `--allow-net=`,
		// which Deno reads as "allow nothing" and would kill the worker's own bind.
		expect(denoPermissionFlags(["network"], { ...options, netAllow: parseNetAllowList(" , ") })[0]).toBe("--allow-net");
	});

	it("never derives --allow-ffi from any effect", () => {
		const everyEffect = ["network", "filesystem", "write", "read", "process", "secret", "streaming", "destructive"];
		expect(denoPermissionFlags(everyEffect as never, options).join(" ")).not.toContain("ffi");
	});

	it("reports the reason for every grant, so least privilege is inspectable", () => {
		const grants = denoPermissionGrants(["network", "process"], options);
		const byFlag = Object.fromEntries(grants.map((g) => [g.flag, g.reason]));
		expect(byFlag["--allow-net"]).toContain("network");
		expect(byFlag["--allow-net"]).toContain("BLOK_DENO_ALLOW_NET");
		expect(byFlag["--allow-run"]).toContain("process");
		expect(byFlag["--allow-read=/srv/app"]).toContain("baseline");
		expect(denoPermissionGrants([], { ...options, allowAll: true })[0].reason).toContain("BLOK_DENO_ALLOW_ALL");
	});

	it("treats a missing manifest as granting nothing", () => {
		expect(declaredEffects([undefined, null, { effects: ["network"] } as never])).toEqual(["network"]);
		expect(declaredEffects([undefined])).toEqual([]);
	});
});
