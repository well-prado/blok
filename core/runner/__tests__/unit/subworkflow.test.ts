/**
 * The handle-DSL `subworkflow()` primitive (#374) — the callback mirror of the
 * object-style `{ id, subworkflow, inputs }` step. Asserts the emitted IR shape:
 * a `subworkflow` field (NOT `use`), opts passthrough, polymorphic-name lowering,
 * and the same id-uniqueness guard as `step()`.
 */
import { describe, expect, it } from "vitest";
import type { HttpEntry } from "../../src/stepBuilder";
import { subworkflow, workflowCallback } from "../../src/stepBuilder";

type Step = { id: string; subworkflow?: string; use?: string; inputs?: Record<string, unknown>; [k: string]: unknown };

describe("subworkflow()", () => {
	it("emits a { id, subworkflow, inputs } step — no `use` — with opts passed through", async () => {
		const wf = await workflowCallback(
			"orders.create",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: HttpEntry) => {
				subworkflow("receipt", "send-receipt-email", { user: req.body.user }, { wait: true });
			},
		);
		const steps = wf._config.steps as unknown as Step[];
		expect(steps).toHaveLength(1);
		expect(steps[0].id).toBe("receipt");
		expect(steps[0].subworkflow).toBe("send-receipt-email");
		expect(steps[0].use).toBeUndefined(); // dispatches a workflow, not a node
		expect(steps[0].wait).toBe(true);
		expect(steps[0].inputs).toBeDefined(); // the handle input was lowered (not the raw proxy)
	});

	it("lowers a HANDLE name to a js/ctx expression (polymorphic dispatch) + keeps allowList", async () => {
		const wf = await workflowCallback(
			"router",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: HttpEntry) => {
				subworkflow("dispatch", req.body.kind, { event: req.body }, { allowList: ["handler.a", "handler.b"] });
			},
		);
		const step = (wf._config.steps as unknown as Step[])[0];
		expect(typeof step.subworkflow).toBe("string");
		expect(step.subworkflow).toContain("js/ctx"); // a handle name lowers to a ctx expression
		expect(step.subworkflow).toContain("kind");
		expect(step.allowList).toEqual(["handler.a", "handler.b"]);
	});

	it("supports wait:false (fire-and-forget) and `as` renaming", async () => {
		const wf = await workflowCallback(
			"notify-flow",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			() => {
				subworkflow("send", "notify", { msg: "hi" }, { wait: false, as: "notification" });
			},
		);
		const step = (wf._config.steps as unknown as Step[])[0];
		expect(step.subworkflow).toBe("notify");
		expect(step.wait).toBe(false);
		expect(step.as).toBe("notification");
	});

	it("lowers a handle-valued idempotencyKey option without touching subworkflow allowList", async () => {
		const wf = await workflowCallback(
			"cached-router",
			{ version: "1.0.0", trigger: { http: { method: "POST" } } },
			(req: HttpEntry) => {
				subworkflow(
					"dispatch",
					req.body.kind,
					{ event: req.body },
					{ allowList: ["handler.a"], idempotencyKey: req.body.requestId },
				);
			},
		);
		const step = (wf._config.steps as unknown as Step[])[0];
		expect(step.subworkflow).toBe("js/ctx.request.body.kind");
		expect(step.idempotencyKey).toBe("js/ctx.request.body.requestId");
		expect(step.allowList).toEqual(["handler.a"]);
	});

	it("throws on a duplicate step id (shared with step()/branch()'s flat id space)", async () => {
		await expect(
			workflowCallback("dup", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				subworkflow("same", "a", {});
				subworkflow("same", "b", {});
			}),
		).rejects.toThrow(/Duplicate step id/);
	});

	it("throws when the name is empty and not a handle", async () => {
		await expect(
			workflowCallback("bad", { version: "1.0.0", trigger: { http: { method: "POST" } } }, () => {
				subworkflow("x", "", {});
			}),
		).rejects.toThrow(/requires a workflow name/);
	});
});
