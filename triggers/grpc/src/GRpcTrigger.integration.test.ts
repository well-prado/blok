/**
 * gRPC trigger end-to-end integration test (issue #600).
 *
 * Stands up the REAL gRPC trigger on a live HTTP/2 port — the exact boot
 * path `GrpcServer.start()` uses: a fastify `{ http2: true }` server with
 * `@connectrpc/connect-fastify`'s `fastifyConnectPlugin`, wired via
 * `trigger.processRequest(router, trigger)`. It is then driven by the
 * repo's OWN gRPC client (`GrpcClient`, backed by
 * `@connectrpc/connect-node`'s `createGrpcTransport`) over the wire.
 * Nothing about the transport, the Connect codec, the trigger's decode /
 * execute / middleware / error-encode path, or the runner is mocked — only
 * OTel is stubbed to avoid needing an exporter.
 *
 * Gating: this test boots a real network listener, so it is gated on
 * `RUN_GRPC_IT` (unset → the whole suite is skipped). The port + node /
 * workflow names carry a per-run random suffix so a concurrent target on
 * the same box never collides.
 *
 * The ONLY execution path the trigger exposes on the wire is the
 * "remote node" path (`GRpcTrigger.executeWorkflow`): the decoded message
 * must carry a `workflow` object, and the trigger synthesizes an ephemeral
 * single-step workflow around the node named by `request.Name`, resolving
 * that node from its in-process `nodeMap.nodes`. This is exactly what the
 * shipped `NanoSDK.nodejs()` / `.python3()` helpers do. The fixture node is
 * injected into the trigger's `nodeMap` before boot so we drive a fully
 * in-process module node (no external HTTP dependency) and can force a
 * throw for the error-mapping assertion.
 *
 * A module-level `EXECUTIONS` array records each node-body invocation so
 * assertions prove the workflow ACTUALLY ran on the far side of the wire —
 * not just that a well-formed response came back.
 *
 * Coverage vs. the four #600 behaviours:
 *   1. UNARY  — a real gRPC call runs the workflow and returns the real,
 *      decoded node output. (observable EXECUTIONS effect + decoded body)
 *   2. ORDERED multi-message — the proto/service is UNARY-only
 *      (`methodKind: "unary"`; there is no server-streaming RPC on the
 *      wire), so true gRPC server-streaming is not implementable against
 *      this adapter. We instead prove ordered, multi-message delivery over
 *      the real wire via N sequential unary calls, asserting the far side
 *      received them in order. (See the NOTE on the test itself — we do NOT
 *      fake a streaming RPC.)
 *   3. MIDDLEWARE — a trigger-level middleware chain (`trigger.grpc
 *      .middleware`) runs before the body; the "allow" middleware mutates
 *      ctx.state (observable in the node output) and the "deny" middleware
 *      throws a 401 GlobalError that short-circuits the body (the node
 *      never runs) and surfaces as the mapped error envelope.
 *   4. ERROR MAPPING — a thrown workflow error is caught and mapped to the
 *      adapter's error envelope: the message travels back in the response
 *      `Message` field with `Type: TEXT` (NOT the success `JSON` type), the
 *      RPC does not crash the server, and a follow-up healthy call still
 *      succeeds. NOTE: this adapter deliberately does NOT translate the
 *      workflow error into a non-OK gRPC/Connect status Code — it returns
 *      the error INSIDE an OK response envelope, which is the contract the
 *      shipped `NanoSDK`/`MessageDecode.responseDecode` consumer already
 *      depends on. So the non-vacuous, truthful assertion here is on the
 *      envelope shape, not on a Connect `Code`.
 */

import type { AddressInfo } from "node:net";
import { workflow } from "@blokjs/helper";
import { NodeMap, WorkflowRegistry, defineNode } from "@blokjs/runner";
import { GlobalError } from "@blokjs/shared";
import type { ConnectRouter } from "@connectrpc/connect";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@opentelemetry/api", () => {
	const noop = { setAttribute: () => {}, setStatus: () => {}, recordException: () => {}, end: () => {} };
	return {
		trace: {
			getTracer: () => ({
				startActiveSpan: (...a: unknown[]) => {
					const fn = a.find((x) => typeof x === "function") as ((s: typeof noop) => unknown) | undefined;
					return fn?.(noop);
				},
				startSpan: () => noop,
			}),
			getActiveSpan: () => undefined,
			setSpan: (c: unknown) => c,
		},
		metrics: {
			getMeter: () => ({
				createCounter: () => ({ add: () => {} }),
				createHistogram: () => ({ record: () => {} }),
				createGauge: () => ({ record: () => {} }),
				createObservableGauge: () => ({ addCallback: () => {} }),
			}),
		},
		context: { active: () => ({}), with: (_c: unknown, fn: () => unknown) => fn() },
		propagation: { extract: (c: unknown) => c, inject: () => {} },
		SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 },
		SpanStatusCode: { OK: 0, ERROR: 1 },
		isSpanContextValid: () => false,
	};
});

import GRpcTrigger from "./GRpcTrigger";
import GrpcClient, { HttpVersionEnum, TransportEnum, type WorkflowRequest } from "./GrpcClient";
import MessageDecode from "./MessageDecode";

const RUN = process.env.RUN_GRPC_IT ? describe : describe.skip;

// Per-run namespace so a concurrent target on the same box never collides
// on the node name / workflow name registered in shared singletons.
const SUFFIX = Math.random().toString(36).slice(2);
const NODE_NAME = `echo-node-${SUFFIX}`;
const THROW_NODE = `boom-node-${SUFFIX}`;
const ALLOW_MW = `allow-mw-${SUFFIX}`;
const DENY_MW = `deny-mw-${SUFFIX}`;
const ALLOW_MW_NODE = `allow-mw-node-${SUFFIX}`;
const DENY_MW_NODE = `deny-mw-node-${SUFFIX}`;

// Observable side effect: every fixture-node body pushes here. Assertions
// read it to prove the node ran on the far side of the real gRPC wire.
type Exec = { node: string; seq: number | undefined };
const EXECUTIONS: Exec[] = [];

// --- fixture nodes (all pure in-process — no external services) ---

const echoNode = defineNode({
	name: NODE_NAME,
	description: "test fixture — echo input + record the run",
	input: z.object({ seq: z.number().optional(), payload: z.string().optional() }).passthrough(),
	output: z.object({ echoed: z.string(), seq: z.number().optional(), viaMiddleware: z.string().optional() }),
	async execute(ctx, input) {
		EXECUTIONS.push({ node: NODE_NAME, seq: input.seq });
		// The "allow" middleware writes ctx.state.mwStamp; surface it in the
		// output so the test can observe the middleware effect over the wire.
		const viaMiddleware = (ctx.state as Record<string, unknown>)?.mwStamp as string | undefined;
		return { echoed: input.payload ?? "ok", seq: input.seq, viaMiddleware };
	},
});

const throwNode = defineNode({
	name: THROW_NODE,
	description: "test fixture — always throws a coded GlobalError",
	input: z.object({}).passthrough(),
	output: z.object({ never: z.string() }),
	async execute() {
		EXECUTIONS.push({ node: THROW_NODE, seq: undefined });
		const err = new GlobalError("kaboom-from-node");
		err.setCode(422);
		throw err;
	},
});

// Middleware body nodes. `applyMiddlewareChain` runs these on the same ctx
// BEFORE the main workflow body, so state they write is visible downstream.
const allowMwNode = defineNode({
	name: ALLOW_MW_NODE,
	description: "test fixture — middleware that stamps ctx.state and passes",
	input: z.object({}).passthrough(),
	output: z.object({ ok: z.boolean() }),
	async execute(ctx) {
		(ctx.state as Record<string, unknown>).mwStamp = "stamped-by-allow-mw";
		return { ok: true };
	},
});

const denyMwNode = defineNode({
	name: DENY_MW_NODE,
	description: "test fixture — auth-gate middleware that rejects",
	input: z.object({}).passthrough(),
	output: z.object({ never: z.string() }),
	async execute() {
		const err = new GlobalError("unauthorized-by-mw");
		err.setCode(401);
		throw err;
	},
});

/** Build the middleware workflow object the WorkflowRegistry expects. */
function middlewareWorkflow(name: string, nodeName: string) {
	return {
		name,
		version: "1.0.0",
		description: `${name} middleware`,
		middleware: true,
		trigger: { grpc: {} },
		steps: [{ id: "mw", use: nodeName, type: "module", inputs: {} }],
		nodes: { mw: { inputs: {} } },
	};
}

/**
 * Encode a message the way the wire expects it: JSON `{ request, workflow }`
 * → BASE64. `workflow` carries the model the remote-node path reads
 * (`steps[0].type`, `trigger`, `nodes.node.inputs`).
 */
function encodeRequest(
	nodeName: string,
	inputs: Record<string, unknown>,
	opts?: { middleware?: string[] },
): WorkflowRequest {
	const model = {
		name: "Remote Node",
		version: "1.0.0",
		description: "remote node exec",
		trigger: { grpc: opts?.middleware ? { middleware: opts.middleware } : {} },
		steps: [{ id: "node", use: nodeName, type: "module" }],
		nodes: { node: { inputs } },
	};
	const message = Buffer.from(JSON.stringify({ request: {}, workflow: model })).toString("base64");
	return {
		$typeName: "blok.workflow.v1.WorkflowRequest",
		Name: nodeName,
		Message: message,
		Encoding: "BASE64",
		Type: "JSON",
	} as WorkflowRequest;
}

RUN("GRpcTrigger — #600 live integration (real gRPC wire)", () => {
	// http2 instance — its RawServer/Request/Reply differ from the http1 default,
	// so the generics must be the node:http2 types (matches `fastify({ http2: true })`).
	let server: FastifyInstance<
		import("node:http2").Http2Server,
		import("node:http2").Http2ServerRequest,
		import("node:http2").Http2ServerResponse
	>;
	let client: GrpcClient;
	const decoder = new MessageDecode();

	beforeAll(async () => {
		process.env.BLOK_TRACE_ENABLED = "false";
		WorkflowRegistry.resetInstance();

		const trigger = new GRpcTrigger();

		// Inject fixture nodes + the middleware workflows into the trigger's
		// nodeMap BEFORE boot. `processRequest` seeds the WorkflowRegistry
		// from `nodeMap.workflows` (via `registerWorkflowsFromNodeMap`), so
		// the middleware chain can resolve `allow-mw` / `deny-mw` by name.
		const nm = (trigger as unknown as { nodeMap: { nodes: NodeMap; workflows: Record<string, unknown> } }).nodeMap;
		nm.nodes = nm.nodes ?? new NodeMap();
		nm.nodes.addNode(NODE_NAME, echoNode);
		nm.nodes.addNode(THROW_NODE, throwNode);
		nm.nodes.addNode(ALLOW_MW_NODE, allowMwNode);
		nm.nodes.addNode(DENY_MW_NODE, denyMwNode);
		nm.workflows = nm.workflows ?? {};
		nm.workflows[ALLOW_MW] = workflow(middlewareWorkflow(ALLOW_MW, ALLOW_MW_NODE) as never);
		nm.workflows[DENY_MW] = workflow(middlewareWorkflow(DENY_MW, DENY_MW_NODE) as never);

		// Boot the REAL trigger the way GrpcServer.start() does.
		server = fastify({ http2: true });
		await server.register(fastifyConnectPlugin, {
			routes: (router: ConnectRouter) => trigger.processRequest(router, trigger),
		});
		await server.listen({ host: "127.0.0.1", port: 0 });

		const port = (server.server.address() as AddressInfo).port;
		client = new GrpcClient({
			host: "127.0.0.1",
			port,
			protocol: "http",
			httpVersion: HttpVersionEnum.HTTP2,
			transport: TransportEnum.GRPC,
		});
	}, 20_000);

	afterAll(async () => {
		if (server) await server.close();
		WorkflowRegistry.resetInstance();
		process.env.BLOK_TRACE_ENABLED = undefined;
	});

	it("1) UNARY — a real gRPC call runs the workflow and returns the decoded node output", async () => {
		EXECUTIONS.length = 0;
		const res = await client.call(encodeRequest(NODE_NAME, { payload: "hello-grpc", seq: 1 }));

		// Real wire response — decode it the way NanoSDK does.
		const body = decoder.responseDecode(res) as { echoed?: string; seq?: number };
		expect(body.echoed).toBe("hello-grpc");
		expect(body.seq).toBe(1);
		// Observable proof the node body executed exactly once on the far side.
		expect(EXECUTIONS).toEqual([{ node: NODE_NAME, seq: 1 }]);
	}, 15_000);

	it("2) ORDERED multi-message — N sequential unary calls arrive in order (unary-only proto; no server-streaming RPC exists)", async () => {
		// NOTE: the WorkflowService is `methodKind: "unary"` only — there is
		// no server-streaming method on the wire — so we prove ordered
		// multi-message delivery via sequential unary calls rather than
		// faking a streaming RPC that the adapter does not expose.
		EXECUTIONS.length = 0;
		const seqs = [10, 11, 12, 13];
		const bodies: Array<{ seq?: number }> = [];
		for (const seq of seqs) {
			const res = await client.call(encodeRequest(NODE_NAME, { payload: `m-${seq}`, seq }));
			bodies.push(decoder.responseDecode(res) as { seq?: number });
		}
		// Responses came back in request order over the real wire.
		expect(bodies.map((b) => b.seq)).toEqual(seqs);
		// And the far side executed them in the same order.
		expect(EXECUTIONS.map((e) => e.seq)).toEqual(seqs);
	}, 20_000);

	it("3a) MIDDLEWARE (allow) — trigger.grpc.middleware runs before the body and its ctx.state mutation is observable", async () => {
		EXECUTIONS.length = 0;
		const res = await client.call(encodeRequest(NODE_NAME, { payload: "mw", seq: 99 }, { middleware: [ALLOW_MW] }));
		const body = decoder.responseDecode(res) as { echoed?: string; viaMiddleware?: string };
		// The node saw ctx.state.mwStamp — proof the middleware actually ran
		// on the same ctx, before the body.
		expect(body.viaMiddleware).toBe("stamped-by-allow-mw");
		expect(EXECUTIONS).toEqual([{ node: NODE_NAME, seq: 99 }]);
	}, 15_000);

	it("3b) MIDDLEWARE (deny) — an auth-gate middleware throw short-circuits the body (node never runs)", async () => {
		EXECUTIONS.length = 0;
		const res = await client.call(
			encodeRequest(NODE_NAME, { payload: "should-not-run", seq: 7 }, { middleware: [DENY_MW] }),
		);
		// The deny middleware threw a 401 GlobalError → mapped to the error
		// envelope (Type: TEXT), and the main workflow body NEVER executed.
		expect(res.Type).toBe("TEXT");
		const msg = Buffer.from(res.Message, "base64").toString("utf-8");
		expect(msg).toContain("unauthorized-by-mw");
		expect(EXECUTIONS).toEqual([]);
	}, 15_000);

	it("4) ERROR MAPPING — a thrown workflow error maps to the error envelope, the server does not crash, and the next call succeeds", async () => {
		EXECUTIONS.length = 0;
		const errRes = await client.call(encodeRequest(THROW_NODE, {}));

		// The adapter caught the throw and returned an OK RPC carrying the
		// error INSIDE the envelope: TEXT type + the raw error message. (This
		// adapter's contract is error-in-envelope, NOT a non-OK Connect Code —
		// see the file header; asserting the envelope is the truthful check.)
		expect(errRes.Type).toBe("TEXT");
		const errMsg = Buffer.from(errRes.Message, "base64").toString("utf-8");
		expect(errMsg).toContain("kaboom-from-node");
		// The node body DID enter (it throws), but produced no success payload.
		expect(EXECUTIONS).toEqual([{ node: THROW_NODE, seq: undefined }]);

		// The error did not poison the server — a fresh healthy call still
		// works over the same live connection, returning a JSON success body.
		EXECUTIONS.length = 0;
		const okRes = await client.call(encodeRequest(NODE_NAME, { payload: "after-error", seq: 2 }));
		expect(okRes.Type).toBe("JSON");
		const okBody = decoder.responseDecode(okRes) as { echoed?: string };
		expect(okBody.echoed).toBe("after-error");
		expect(EXECUTIONS).toEqual([{ node: NODE_NAME, seq: 2 }]);
	}, 15_000);
});
