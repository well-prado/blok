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

	it("isolates overlapping dispatches (fresh Configuration per call)", async () => {
		const [a, b] = await Promise.all([
			trigger.dispatch<{ tenant: string }>("reindex-tenant", { tenantId: "alpha" }),
			trigger.dispatch<{ tenant: string }>("reindex-tenant", { tenantId: "beta" }),
		]);
		expect(a.tenant).toBe("alpha");
		expect(b.tenant).toBe("beta");
	});
});
