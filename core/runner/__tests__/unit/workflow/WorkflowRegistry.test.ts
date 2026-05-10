import type { Context } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RegisteredWorkflow, WorkflowRegistry } from "../../../src/workflow/WorkflowRegistry";

describe("WorkflowRegistry", () => {
	beforeEach(() => {
		WorkflowRegistry.resetInstance();
	});

	afterEach(() => {
		WorkflowRegistry.resetInstance();
	});

	const sampleWorkflow = (name: string, source = "/wf.json"): RegisteredWorkflow => ({
		name,
		source,
		workflow: { name, version: "1.0.0", trigger: { manual: {} }, steps: [] },
	});

	describe("singleton semantics", () => {
		it("returns the same instance on repeated getInstance() calls", () => {
			const a = WorkflowRegistry.getInstance();
			const b = WorkflowRegistry.getInstance();
			expect(a).toBe(b);
		});

		it("returns a fresh instance after resetInstance()", () => {
			const a = WorkflowRegistry.getInstance();
			WorkflowRegistry.resetInstance();
			const b = WorkflowRegistry.getInstance();
			expect(a).not.toBe(b);
		});
	});

	describe("register()", () => {
		it("stores a workflow keyed by name", () => {
			const registry = WorkflowRegistry.getInstance();
			const entry = sampleWorkflow("send-receipt");
			registry.register(entry);
			expect(registry.get("send-receipt")).toBe(entry);
		});

		it("throws when name is empty", () => {
			const registry = WorkflowRegistry.getInstance();
			expect(() => registry.register({ ...sampleWorkflow("ok"), name: "" })).toThrow(/name.*required/);
		});

		it("re-registration with the same (name, source) is idempotent", () => {
			const registry = WorkflowRegistry.getInstance();
			const entry = sampleWorkflow("dup", "/wf.json");
			registry.register(entry);
			expect(() => registry.register(entry)).not.toThrow();
			expect(registry.list()).toHaveLength(1);
		});

		it("throws on collision: same name, different source", () => {
			const registry = WorkflowRegistry.getInstance();
			registry.register(sampleWorkflow("clash", "/a.json"));
			expect(() => registry.register(sampleWorkflow("clash", "/b.json"))).toThrow(/collision/);
		});
	});

	describe("registerAll()", () => {
		it("registers every entry in order", () => {
			const registry = WorkflowRegistry.getInstance();
			registry.registerAll([sampleWorkflow("a"), sampleWorkflow("b"), sampleWorkflow("c")]);
			expect(
				registry
					.list()
					.map((w) => w.name)
					.sort(),
			).toEqual(["a", "b", "c"]);
		});

		it("stops on the first collision (partial registration is acceptable)", () => {
			const registry = WorkflowRegistry.getInstance();
			expect(() =>
				registry.registerAll([
					sampleWorkflow("a", "/a.json"),
					sampleWorkflow("b", "/b.json"),
					sampleWorkflow("a", "/conflict.json"),
				]),
			).toThrow(/collision/);
			// First two were registered before the collision aborted.
			expect(registry.has("a")).toBe(true);
			expect(registry.has("b")).toBe(true);
		});
	});

	describe("get() / has()", () => {
		it("returns undefined / false on miss", () => {
			const registry = WorkflowRegistry.getInstance();
			expect(registry.get("missing")).toBeUndefined();
			expect(registry.has("missing")).toBe(false);
		});

		it("returns the entry / true on hit", () => {
			const registry = WorkflowRegistry.getInstance();
			const entry = sampleWorkflow("found");
			registry.register(entry);
			expect(registry.get("found")).toBe(entry);
			expect(registry.has("found")).toBe(true);
		});
	});

	describe("authorize hook (setAuthorizeFn)", () => {
		const stubCtx = (overrides: Partial<Context> = {}): Context =>
			({
				workflow_name: "parent",
				request: { headers: {}, body: {}, query: {}, params: {} },
				...overrides,
			}) as unknown as Context;

		it("default-allows when no fn is installed", async () => {
			const registry = WorkflowRegistry.getInstance();
			expect(await registry.authorize("parent", "child", stubCtx())).toBe(true);
		});

		it("delegates to the installed fn (sync false)", async () => {
			const registry = WorkflowRegistry.getInstance();
			const fn = vi.fn().mockReturnValue(false);
			registry.setAuthorizeFn(fn);
			expect(await registry.authorize("p", "c", stubCtx())).toBe(false);
			expect(fn).toHaveBeenCalledWith("p", "c", expect.objectContaining({ workflow_name: "parent" }));
		});

		it("delegates to the installed fn (async true)", async () => {
			const registry = WorkflowRegistry.getInstance();
			registry.setAuthorizeFn(async () => true);
			expect(await registry.authorize("p", "c", stubCtx())).toBe(true);
		});

		it("delegates to the installed fn (async false)", async () => {
			const registry = WorkflowRegistry.getInstance();
			registry.setAuthorizeFn(async () => false);
			expect(await registry.authorize("p", "c", stubCtx())).toBe(false);
		});

		it("setAuthorizeFn(null) clears the hook", async () => {
			const registry = WorkflowRegistry.getInstance();
			registry.setAuthorizeFn(() => false);
			expect(await registry.authorize("p", "c", stubCtx())).toBe(false);
			registry.setAuthorizeFn(null);
			expect(await registry.authorize("p", "c", stubCtx())).toBe(true);
		});

		it("hook receives parentName, childName, ctx in order", async () => {
			const registry = WorkflowRegistry.getInstance();
			const calls: Array<[string, string, string]> = [];
			registry.setAuthorizeFn((parent, child, ctx) => {
				calls.push([parent, child, ctx.workflow_name ?? ""]);
				return true;
			});
			await registry.authorize("orders", "send-receipt", stubCtx({ workflow_name: "orders" }));
			expect(calls).toEqual([["orders", "send-receipt", "orders"]]);
		});

		it("clear() does NOT reset the authorize hook (HMR-friendly)", async () => {
			const registry = WorkflowRegistry.getInstance();
			registry.setAuthorizeFn(() => false);
			registry.clear();
			expect(await registry.authorize("p", "c", stubCtx())).toBe(false);
		});

		it("resetInstance() drops the hook (test isolation)", async () => {
			const registry1 = WorkflowRegistry.getInstance();
			registry1.setAuthorizeFn(() => false);
			WorkflowRegistry.resetInstance();
			const registry2 = WorkflowRegistry.getInstance();
			expect(await registry2.authorize("p", "c", stubCtx())).toBe(true);
		});
	});

	describe("clear()", () => {
		it("drops all registered workflows", () => {
			const registry = WorkflowRegistry.getInstance();
			registry.registerAll([sampleWorkflow("a"), sampleWorkflow("b")]);
			registry.clear();
			expect(registry.list()).toHaveLength(0);
			expect(registry.has("a")).toBe(false);
		});

		it("supports re-registration after clear (HMR pattern)", () => {
			const registry = WorkflowRegistry.getInstance();
			registry.register(sampleWorkflow("hot", "/old.json"));
			registry.clear();
			// Same name, different source — would have collided before clear.
			expect(() => registry.register(sampleWorkflow("hot", "/new.json"))).not.toThrow();
			expect(registry.get("hot")?.source).toBe("/new.json");
		});
	});

	// v0.5.4 — process-global middleware. The registry holds a single
	// frozen list that triggers prepend to every workflow run's chain.
	// Tests pin: getter returns empty when unset, setter replaces,
	// repeated calls last-wins, empty array clears, non-string entries
	// are filtered, snapshot is frozen, clear() preserves the list.
	describe("global middleware (v0.5.4)", () => {
		it("returns an empty list when no global middleware has been set", () => {
			const registry = WorkflowRegistry.getInstance();
			expect(registry.getGlobalMiddleware()).toEqual([]);
		});

		it("setGlobalMiddleware replaces the chain; getter returns the latest", () => {
			const registry = WorkflowRegistry.getInstance();
			registry.setGlobalMiddleware(["request-id", "audit-log"]);
			expect(registry.getGlobalMiddleware()).toEqual(["request-id", "audit-log"]);
			registry.setGlobalMiddleware(["other-only"]);
			expect(registry.getGlobalMiddleware()).toEqual(["other-only"]);
		});

		it("empty array clears the global chain", () => {
			const registry = WorkflowRegistry.getInstance();
			registry.setGlobalMiddleware(["request-id"]);
			expect(registry.getGlobalMiddleware()).toHaveLength(1);
			registry.setGlobalMiddleware([]);
			expect(registry.getGlobalMiddleware()).toEqual([]);
		});

		it("filters non-string and empty-string entries", () => {
			const registry = WorkflowRegistry.getInstance();
			registry.setGlobalMiddleware(["good", "", "also-good"] as unknown as string[]);
			expect(registry.getGlobalMiddleware()).toEqual(["good", "also-good"]);
		});

		it("snapshot is frozen — callers cannot mutate the stored list", () => {
			const registry = WorkflowRegistry.getInstance();
			registry.setGlobalMiddleware(["request-id"]);
			const snapshot = registry.getGlobalMiddleware();
			expect(Object.isFrozen(snapshot)).toBe(true);
			// Attempting to push a runtime addition into the frozen array
			// throws in strict mode (Vitest defaults to strict).
			expect(() => (snapshot as string[]).push("audit-log")).toThrow();
			expect(registry.getGlobalMiddleware()).toEqual(["request-id"]);
		});

		it("clear() does NOT reset the global middleware (operator state survives HMR)", () => {
			const registry = WorkflowRegistry.getInstance();
			registry.setGlobalMiddleware(["request-id", "audit-log"]);
			registry.register(sampleWorkflow("a", "/a.json"));
			registry.clear();
			// Workflow registrations dropped, global chain preserved.
			expect(registry.list()).toHaveLength(0);
			expect(registry.getGlobalMiddleware()).toEqual(["request-id", "audit-log"]);
		});
	});
});
