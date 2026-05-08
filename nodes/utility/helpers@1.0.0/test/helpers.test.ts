import type { Context } from "@blokjs/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AuditLogNode,
	CtxPublishManyNode,
	CtxPublishNode,
	ExprNode,
	HELPER_NODES,
	InMemoryKvNode,
	JsonSchemaNode,
	LogNode,
	MetricsEmitNode,
	ThrowNode,
	_resetAuditEventsForTests,
	_resetInMemoryKvForTests,
	getAuditEvents,
} from "../src/index";

function ctxFor(): Context {
	const state: Record<string, unknown> = {};
	return {
		id: "test-req",
		workflow_name: "test-wf",
		workflow_path: "/test",
		request: { body: {}, headers: {}, params: {}, query: {} },
		response: { data: {}, success: true, error: null },
		error: { message: [] },
		logger: {
			log: vi.fn(),
			logLevel: vi.fn(),
			error: vi.fn(),
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
}

describe("@blokjs/helpers", () => {
	describe("HELPER_NODES barrel", () => {
		it("exports every helper at its canonical ref", () => {
			expect(Object.keys(HELPER_NODES).sort()).toEqual([
				"@blokjs/audit-log",
				"@blokjs/ctx-publish",
				"@blokjs/ctx-publish-many",
				"@blokjs/expr",
				"@blokjs/in-memory-kv",
				"@blokjs/json-schema",
				"@blokjs/log",
				"@blokjs/metrics-emit",
				"@blokjs/throw",
			]);
		});
	});

	describe("@blokjs/expr", () => {
		it("evaluates a literal expression", async () => {
			const ctx = ctxFor();
			const r = await ExprNode.handle(ctx, { expression: "1 + 2" });
			expect((r as { data: unknown }).data).toBe(3);
		});

		it("reads from ctx.state", async () => {
			const ctx = ctxFor();
			(ctx.state as Record<string, unknown>).counter = 5;
			const r = await ExprNode.handle(ctx, { expression: "ctx.state.counter * 10" });
			expect((r as { data: unknown }).data).toBe(50);
		});

		it("rejects an empty expression at validation time", async () => {
			const ctx = ctxFor();
			const r = await ExprNode.handle(ctx, { expression: "" });
			expect((r as { success: boolean }).success).toBe(false);
		});
	});

	describe("@blokjs/ctx-publish", () => {
		it("sets ctx.state[name] = value", async () => {
			const ctx = ctxFor();
			await CtxPublishNode.handle(ctx, { name: "userId", value: "u-1" });
			expect((ctx.state as Record<string, unknown>).userId).toBe("u-1");
			expect((ctx.vars as Record<string, unknown>).userId).toBe("u-1");
		});

		it("returns the published name + value", async () => {
			const ctx = ctxFor();
			const r = await CtxPublishNode.handle(ctx, { name: "x", value: 42 });
			expect((r as { data: { name: string; value: unknown } }).data).toEqual({ name: "x", value: 42 });
		});
	});

	describe("@blokjs/ctx-publish-many", () => {
		it("sets multiple ctx.state keys in one call", async () => {
			const ctx = ctxFor();
			await CtxPublishManyNode.handle(ctx, { values: { a: 1, b: "two", c: { nested: true } } });
			const state = ctx.state as Record<string, unknown>;
			expect(state.a).toBe(1);
			expect(state.b).toBe("two");
			expect(state.c).toEqual({ nested: true });
		});

		it("reports the count published", async () => {
			const ctx = ctxFor();
			const r = await CtxPublishManyNode.handle(ctx, { values: { a: 1, b: 2, c: 3 } });
			expect((r as { data: { count: number } }).data.count).toBe(3);
		});
	});

	describe("@blokjs/throw", () => {
		it("throws with the configured message", async () => {
			const ctx = ctxFor();
			const r = await ThrowNode.handle(ctx, { message: "boom" });
			// defineNode catches errors and routes them through mapErrorToGlobalError.
			expect((r as { success: boolean }).success).toBe(false);
			expect((r as { error: { message: string } }).error.message).toContain("boom");
		});
	});

	describe("@blokjs/log", () => {
		it("calls ctx.logger.logLevel for non-error levels", async () => {
			const ctx = ctxFor();
			await LogNode.handle(ctx, { level: "info", message: "hello" });
			expect(ctx.logger.logLevel).toHaveBeenCalledWith("info", "hello");
			await LogNode.handle(ctx, { level: "warn", message: "uh oh" });
			expect(ctx.logger.logLevel).toHaveBeenCalledWith("warn", "uh oh");
		});

		it("calls ctx.logger.error for error level", async () => {
			const ctx = ctxFor();
			await LogNode.handle(ctx, { level: "error", message: "boom" });
			expect(ctx.logger.error).toHaveBeenCalled();
		});
	});

	describe("@blokjs/audit-log", () => {
		afterEach(() => _resetAuditEventsForTests());

		it("appends an event to the ring", async () => {
			const ctx = ctxFor();
			await AuditLogNode.handle(ctx, { event: "user-deleted", attrs: { userId: "u1" } });
			const events = getAuditEvents();
			expect(events).toHaveLength(1);
			expect(events[0].event).toBe("user-deleted");
			expect(events[0].attrs).toEqual({ userId: "u1" });
			expect(events[0].timestamp).toBeGreaterThan(0);
			expect(events[0].requestId).toBe("test-req");
		});

		it("bounds the ring at 1000 entries", async () => {
			const ctx = ctxFor();
			for (let i = 0; i < 1010; i++) {
				await AuditLogNode.handle(ctx, { event: `evt-${i}` });
			}
			expect(getAuditEvents()).toHaveLength(1000);
			// First entry should now be evt-10 (oldest 10 dropped).
			expect(getAuditEvents()[0].event).toBe("evt-10");
		});
	});

	describe("@blokjs/metrics-emit", () => {
		it("returns the event + value (no exporter wired in tests)", async () => {
			const ctx = ctxFor();
			const r = await MetricsEmitNode.handle(ctx, { event: "request", value: 1 });
			expect((r as { data: { event: string; value: number } }).data).toEqual({
				event: "request",
				value: 1,
			});
		});
	});

	describe("@blokjs/in-memory-kv", () => {
		afterEach(() => _resetInMemoryKvForTests());

		it("set then get round-trips", async () => {
			const ctx = ctxFor();
			await InMemoryKvNode.handle(ctx, { action: "set", key: "user-1", value: { name: "Alice" } });
			const got = await InMemoryKvNode.handle(ctx, { action: "get", key: "user-1" });
			expect((got as { data: { value: unknown } }).data.value).toEqual({ name: "Alice" });
		});

		it("get on missing key returns undefined value", async () => {
			const ctx = ctxFor();
			const got = await InMemoryKvNode.handle(ctx, { action: "get", key: "missing" });
			expect((got as { data: { value: unknown } }).data.value).toBeUndefined();
		});

		it("delete removes the entry", async () => {
			const ctx = ctxFor();
			await InMemoryKvNode.handle(ctx, { action: "set", key: "x", value: 1 });
			const r = await InMemoryKvNode.handle(ctx, { action: "delete", key: "x" });
			expect((r as { data: { deleted: boolean } }).data.deleted).toBe(true);
			const got = await InMemoryKvNode.handle(ctx, { action: "get", key: "x" });
			expect((got as { data: { value: unknown } }).data.value).toBeUndefined();
		});

		it("list returns all entries when no prefix", async () => {
			const ctx = ctxFor();
			await InMemoryKvNode.handle(ctx, { action: "set", key: "a", value: 1 });
			await InMemoryKvNode.handle(ctx, { action: "set", key: "b", value: 2 });
			const r = await InMemoryKvNode.handle(ctx, { action: "list" });
			const entries = (r as { data: unknown }).data as { key: string; value: unknown }[];
			expect(entries).toHaveLength(2);
		});

		it("list filters by prefix", async () => {
			const ctx = ctxFor();
			await InMemoryKvNode.handle(ctx, { action: "set", key: "user-1", value: { name: "A" } });
			await InMemoryKvNode.handle(ctx, { action: "set", key: "user-2", value: { name: "B" } });
			await InMemoryKvNode.handle(ctx, { action: "set", key: "post-1", value: { title: "P" } });
			const r = await InMemoryKvNode.handle(ctx, { action: "list", prefix: "user-" });
			const entries = (r as { data: unknown }).data as { key: string; value: unknown }[];
			expect(entries).toHaveLength(2);
			expect(entries.every((e) => e.key.startsWith("user-"))).toBe(true);
		});

		it("clear wipes the store", async () => {
			const ctx = ctxFor();
			await InMemoryKvNode.handle(ctx, { action: "set", key: "x", value: 1 });
			await InMemoryKvNode.handle(ctx, { action: "set", key: "y", value: 2 });
			const r = await InMemoryKvNode.handle(ctx, { action: "clear" });
			expect((r as { data: { count: number } }).data.count).toBe(2);
			const list = await InMemoryKvNode.handle(ctx, { action: "list" });
			expect((list as { data: unknown }).data).toEqual([]);
		});
	});

	describe("@blokjs/json-schema", () => {
		it("returns valid: true on matching data", async () => {
			const ctx = ctxFor();
			const r = await JsonSchemaNode.handle(ctx, {
				schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
				data: { name: "Alice" },
			});
			expect((r as { data: { valid: boolean } }).data.valid).toBe(true);
		});

		it("throws on validation failure", async () => {
			const ctx = ctxFor();
			const r = await JsonSchemaNode.handle(ctx, {
				schema: { type: "object", required: ["name"] },
				data: { otherField: "x" },
			});
			expect((r as { success: boolean }).success).toBe(false);
			expect((r as { error: { message: string } }).error.message).toContain("validation failed");
		});
	});
});
