import type { Context } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { createChildContext } from "../../../src/utils/createChildContext";

function makeParent(opts?: { signal?: AbortSignal }): Context {
	const ctx = {
		id: "parent-1",
		workflow_name: "parent-wf",
		workflow_path: "/p",
		request: { body: {}, headers: {}, params: {}, query: {} } as unknown as Context["request"],
		response: { data: null, contentType: "", success: true, error: null } as Context["response"],
		error: { message: [] } as Context["error"],
		logger: { log: () => {} } as unknown as Context["logger"],
		config: {} as unknown as Context["config"],
		state: {},
		vars: {},
		env: {} as unknown as Context["env"],
		eventLogger: null,
		signal: opts?.signal,
		_PRIVATE_: null,
	} as unknown as Context;
	return ctx;
}

describe("createChildContext — AbortSignal propagation (Tier 2 follow-up)", () => {
	it("child gets its own AbortSignal (independent from parent's)", () => {
		const parentController = new AbortController();
		const parent = makeParent({ signal: parentController.signal });
		const child = createChildContext(parent, {
			workflowName: "child",
			workflowPath: "/c",
			body: { foo: 1 },
			config: {} as Context["config"],
		});

		expect(child.signal).toBeDefined();
		expect(child.signal).not.toBe(parent.signal);
	});

	it("child's signal aborts when parent's signal aborts (cascading cancellation)", () => {
		const parentController = new AbortController();
		const parent = makeParent({ signal: parentController.signal });
		const child = createChildContext(parent, {
			workflowName: "child",
			workflowPath: "/c",
			body: {},
			config: {} as Context["config"],
		});

		expect(child.signal?.aborted).toBe(false);
		parentController.abort();
		expect(child.signal?.aborted).toBe(true);
	});

	it("child gets a pre-aborted signal when parent was already aborted", () => {
		const parentController = new AbortController();
		parentController.abort();
		const parent = makeParent({ signal: parentController.signal });

		const child = createChildContext(parent, {
			workflowName: "child",
			workflowPath: "/c",
			body: {},
			config: {} as Context["config"],
		});

		expect(child.signal?.aborted).toBe(true);
	});

	it("aborting the child does NOT abort the parent (independent lifecycle)", () => {
		const parentController = new AbortController();
		const parent = makeParent({ signal: parentController.signal });
		const child = createChildContext(parent, {
			workflowName: "child",
			workflowPath: "/c",
			body: {},
			config: {} as Context["config"],
		});

		const childPrivate = child._PRIVATE_ as { abortController: AbortController };
		childPrivate.abortController.abort();

		expect(child.signal?.aborted).toBe(true);
		expect(parent.signal?.aborted).toBe(false);
	});

	it("child without parent.signal still gets a fresh AbortController", () => {
		const parent = makeParent(); // no parent.signal
		const child = createChildContext(parent, {
			workflowName: "child",
			workflowPath: "/c",
			body: {},
			config: {} as Context["config"],
		});

		expect(child.signal).toBeDefined();
		expect(child.signal?.aborted).toBe(false);
	});

	// PR 1 follow-up · A3 fix. Verifies the listener-cleanup signal is
	// wired so children clean up their abort listener on completion.
	it("listenerCleanup is exposed on child._PRIVATE_ (PR 1 A3 fix)", () => {
		const parentController = new AbortController();
		const parent = makeParent({ signal: parentController.signal });
		const child = createChildContext(parent, {
			workflowName: "child",
			workflowPath: "/c",
			body: {},
			config: {} as Context["config"],
		});

		const childPrivate = child._PRIVATE_ as {
			abortController: AbortController;
			listenerCleanup: AbortController;
		};
		expect(childPrivate.listenerCleanup).toBeInstanceOf(AbortController);
		expect(childPrivate.listenerCleanup.signal.aborted).toBe(false);
	});

	it("aborting listenerCleanup before parent abort detaches the listener (PR 1 A3 fix)", () => {
		// Detach the listener mid-life. After detach, parent abort should
		// NOT propagate to the child — proves the listener was actually
		// removed (not just made idle).
		const parentController = new AbortController();
		const parent = makeParent({ signal: parentController.signal });
		const child = createChildContext(parent, {
			workflowName: "child",
			workflowPath: "/c",
			body: {},
			config: {} as Context["config"],
		});

		const childPrivate = child._PRIVATE_ as {
			abortController: AbortController;
			listenerCleanup: AbortController;
		};

		// Simulate child completion — abort the listener-cleanup signal.
		childPrivate.listenerCleanup.abort();

		// Now abort the parent. With the listener detached, the child's
		// signal should remain unaborted.
		parentController.abort();

		expect(child.signal?.aborted).toBe(false);
	});

	it("100 sequential child contexts on one parent stay below MaxListeners warning (PR 1 A3 fix)", () => {
		// Without the {signal:} cleanup, each createChildContext leaks a
		// listener on the parent's AbortSignal. Node's default is 10
		// listeners before a warning. After 100 children with cleanup, we
		// should not see the warning.
		const parentController = new AbortController();
		const parent = makeParent({ signal: parentController.signal });

		const warnings: string[] = [];
		const originalEmitWarning = process.emitWarning;
		process.emitWarning = ((msg: unknown) => {
			warnings.push(String(msg));
		}) as typeof process.emitWarning;

		try {
			for (let i = 0; i < 100; i++) {
				const child = createChildContext(parent, {
					workflowName: `child-${i}`,
					workflowPath: "/c",
					body: {},
					config: {} as Context["config"],
				});
				const childPrivate = child._PRIVATE_ as { listenerCleanup: AbortController };
				// Simulate child completion immediately so listener detaches.
				childPrivate.listenerCleanup.abort();
			}
		} finally {
			process.emitWarning = originalEmitWarning;
		}

		// No MaxListenersExceededWarning expected.
		const maxWarn = warnings.find((w) => w.includes("MaxListenersExceededWarning") || w.includes("maxListeners"));
		expect(maxWarn).toBeUndefined();
	});
});
