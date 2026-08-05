/**
 * #435 — ManualTrigger: programmatic dispatch + args typing + no-listener guarantee.
 *
 * The manual trigger is the PUSH entrypoint (#434): host code calls
 * `dispatch(name, args)` instead of an external event arriving on a socket. This
 * drives the REAL runner path — `listen()` registers the trigger's workflows,
 * `dispatch()` builds a root ctx with the args at `ctx.request.body`, runs the
 * workflow to completion, and returns `ctx.response.data`. So we assert:
 *   - the args actually reach the workflow (resolved through the Mapper from
 *     ctx.request.body — the `args` entry handle leg),
 *   - the workflow result comes back to the caller,
 *   - dispatching an unregistered name throws loudly (the no-listener guarantee,
 *     the push-model analogue of "an event with no listener"),
 *   - overlapping dispatches stay isolated (fresh Configuration per call).
 */

import { type WorkflowV2Builder, workflow } from "@blokjs/helper";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import ManualTrigger from "../../src/ManualTrigger";
import NodeMap from "../../src/NodeMap";
import { defineNode } from "../../src/defineNode";
import { WorkflowRegistry } from "../../src/workflow/WorkflowRegistry";

// Echoes the resolved `tenant` arg back out, so the dispatch result proves the
// arg traveled ctx.request.body → Mapper → node input → ctx.response.data.
const echoArgs = defineNode({
	name: "echo-args",
	description: "echo the resolved tenant arg",
	input: z.object({ tenant: z.string() }),
	output: z.object({ tenant: z.string(), upper: z.string() }),
	execute: (_ctx, input) => ({ tenant: input.tenant, upper: input.tenant.toUpperCase() }),
});

function manualWf(): WorkflowV2Builder {
	return workflow({
		name: "reindex-tenant",
		version: "1.0.0",
		trigger: { manual: {} },
		steps: [{ id: "echo", use: "echo-args", type: "module", inputs: { tenant: "js/ctx.request.body.tenantId" } }],
	}) as unknown as WorkflowV2Builder;
}

function buildTrigger(): ManualTrigger {
	const nodes = new NodeMap();
	nodes.addNode("echo-args", echoArgs);
	const trigger = new ManualTrigger();
	trigger.setNodeMap({ nodes, workflows: { "reindex-tenant": manualWf() } });
	return trigger;
}

describe("ManualTrigger (#435)", () => {
	let trigger: ManualTrigger;

	beforeEach(async () => {
		WorkflowRegistry.resetInstance();
		trigger = buildTrigger();
		await trigger.listen();
	});

	afterEach(() => {
		void trigger.stop?.();
		WorkflowRegistry.resetInstance();
	});

	it("registers its workflows on listen() so they resolve by name", () => {
		expect(WorkflowRegistry.getInstance().has("reindex-tenant")).toBe(true);
	});

	it("dispatches a registered workflow — args reach ctx.request.body and the result returns", async () => {
		const result = await trigger.dispatch<{ tenant: string; upper: string }>("reindex-tenant", { tenantId: "t_123" });
		// The arg resolved through ctx.request.body (the `args` entry handle leg)
		// AND the workflow ran (upper proves the node executed, not just an echo).
		expect(result).toEqual({ tenant: "t_123", upper: "T_123" });
	});

	it("throws loudly when dispatching an unregistered name (no-listener guarantee)", async () => {
		await expect(trigger.dispatch("does-not-exist", {})).rejects.toThrow(
			/no workflow named "does-not-exist" is registered/,
		);
	});

	it("throws on an empty workflow name", async () => {
		// @ts-expect-error — exercising the runtime guard with a bad arg
		await expect(trigger.dispatch("", {})).rejects.toThrow(/non-empty workflow name/);
	});

	it("runs workflow-level middleware on dispatch (F2 hazard regression)", async () => {
		// Regression: dispatch() built a fresh per-call Configuration but let
		// applyMiddlewareChain default to the never-initialized shared one, so
		// `middleware: ["stamp-mw"]` was silently dropped and the main step saw
		// an empty ctx.state (Studio test-runs of v05-hello-with-mw hit this).
		const stamp = defineNode({
			name: "stamp",
			description: "middleware step whose output persists to ctx.state",
			input: z.object({}),
			output: z.object({ via: z.string() }),
			execute: () => ({ via: "stamp-mw" }),
		});
		const echoVia = defineNode({
			name: "echo-via",
			description: "read the middleware-written state slot",
			input: z.object({ via: z.string() }),
			output: z.object({ via: z.string() }),
			execute: (_ctx, input) => ({ via: input.via }),
		});
		const nodes = new NodeMap();
		nodes.addNode("stamp", stamp);
		nodes.addNode("echo-via", echoVia);
		const mwTrigger = new ManualTrigger();
		mwTrigger.setNodeMap({
			nodes,
			workflows: {
				"stamp-mw": {
					name: "stamp-mw",
					version: "1.0.0",
					middleware: true,
					steps: [{ id: "mw-stamp", use: "stamp", type: "module", inputs: {} }],
				},
				"hello-mw": {
					name: "hello-mw",
					version: "1.0.0",
					middleware: ["stamp-mw"],
					trigger: { manual: {} },
					steps: [{ id: "respond", use: "echo-via", type: "module", inputs: { via: "js/ctx.state['mw-stamp'].via" } }],
				},
			} as never,
		});
		await mwTrigger.listen();
		const result = await mwTrigger.dispatch<{ via: string }>("hello-mw", {});
		expect(result).toEqual({ via: "stamp-mw" });
	});

	it("isolates overlapping dispatches (fresh Configuration per call)", async () => {
		const [a, b] = await Promise.all([
			trigger.dispatch<{ tenant: string }>("reindex-tenant", { tenantId: "alpha" }),
			trigger.dispatch<{ tenant: string }>("reindex-tenant", { tenantId: "beta" }),
		]);
		expect(a.tenant).toBe("alpha");
		expect(b.tenant).toBe("beta");
	});
});
