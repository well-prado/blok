import { describe, expect, it } from "vitest";
import { inferSampleBody } from "../../../src/workflow/sampleBody";

/**
 * Convenience: read the body from `inferSampleBody` while asserting
 * the source kind. Keeps the tests narrow when both shape + source
 * are interesting (e.g. "this was the AUTHOR's body, not inferred").
 */
function infer(workflow: unknown): { body: unknown; source: "author" | "inferred" | "empty" } {
	const result = inferSampleBody(workflow);
	if (!result) throw new Error("expected a sample body result");
	return result;
}

describe("inferSampleBody · author override", () => {
	it("returns the declared body verbatim when `trigger.http.examples.body` is set", () => {
		const workflow = {
			name: "test",
			trigger: {
				http: {
					method: "POST",
					path: "/test",
					examples: {
						body: { customer: { id: "cust_demo", email: "demo@example.com" }, items: [{ sku: "ABC", qty: 1 }] },
					},
				},
			},
			steps: [{ id: "ignored", use: "@blokjs/respond", inputs: { body: "js/ctx.request.body.something_else" } }],
		};
		const result = infer(workflow);
		expect(result.source).toBe("author");
		expect(result.body).toEqual({
			customer: { id: "cust_demo", email: "demo@example.com" },
			items: [{ sku: "ABC", qty: 1 }],
		});
	});

	it("accepts non-object bodies (array, string) from the author verbatim", () => {
		const result = infer({
			trigger: { http: { examples: { body: ["a", "b"] } } },
			steps: [],
		});
		expect(result.source).toBe("author");
		expect(result.body).toEqual(["a", "b"]);
	});

	it("treats `null` author bodies as a missing override (falls back to inference)", () => {
		const result = infer({
			trigger: { http: { examples: { body: undefined } } },
			steps: [],
		});
		expect(result.source).toBe("empty");
	});
});

describe("inferSampleBody · empty / no references", () => {
	it("returns `{ body: {}, source: 'empty' }` when there are no body references", () => {
		const result = infer({
			trigger: { http: { method: "POST", path: "/echo" } },
			steps: [{ id: "respond", use: "@blokjs/respond", inputs: { body: { ok: true } } }],
		});
		expect(result.source).toBe("empty");
		expect(result.body).toEqual({});
	});

	it("returns `null` for non-object workflow values", () => {
		expect(inferSampleBody(null)).toBeNull();
		expect(inferSampleBody("string")).toBeNull();
		expect(inferSampleBody(42)).toBeNull();
		expect(inferSampleBody([])).toBeNull();
	});
});

describe("inferSampleBody · regular step inputs", () => {
	it("collects a flat top-level field referenced via `ctx.request.body.X`", () => {
		const result = infer({
			steps: [{ id: "echo", use: "@blokjs/respond", inputs: { body: "js/ctx.request.body.userId" } }],
		});
		expect(result.source).toBe("inferred");
		expect(result.body).toEqual({ userId: "string" });
	});

	it("collects a nested field referenced via `ctx.request.body.X.Y.Z`", () => {
		const result = infer({
			steps: [
				{
					id: "echo",
					use: "@blokjs/respond",
					inputs: { body: "js/ctx.request.body.customer.address.zip" },
				},
			],
		});
		expect(result.body).toEqual({ customer: { address: { zip: "string" } } });
	});

	it("collects both `ctx.request.body.X` and `$.req.body.X` syntaxes", () => {
		const result = infer({
			steps: [
				{ id: "a", use: "n", inputs: { x: "js/ctx.request.body.first" } },
				{ id: "b", use: "n", inputs: { x: "$.req.body.second" } },
			],
		});
		expect(result.body).toEqual({ first: "string", second: "string" });
	});

	it("merges multiple references to the same sub-tree without losing fields", () => {
		const result = infer({
			steps: [
				{ id: "a", use: "n", inputs: { x: "js/ctx.request.body.event.id", y: "js/ctx.request.body.event.kind" } },
			],
		});
		expect(result.body).toEqual({ event: { id: "string", kind: "string" } });
	});

	it("a path that's both referenced as a whole AND with a sub-field keeps the sub-field structure", () => {
		const result = infer({
			steps: [
				{
					id: "a",
					use: "n",
					inputs: {
						// Bare reference (e.g. body: "js/ctx.request.body.event")
						bareEvent: "js/ctx.request.body.event",
						// Sub-field reference
						eventId: "js/ctx.request.body.event.id",
					},
				},
			],
		});
		expect(result.body).toEqual({ event: { id: "string" } });
	});

	it("walks nested objects and arrays inside step inputs", () => {
		const result = infer({
			steps: [
				{
					id: "a",
					use: "n",
					inputs: {
						headers: { "X-User-Id": "js/ctx.request.body.user.id" },
						params: ["js/ctx.request.body.actions[0]"],
					},
				},
			],
		});
		// `actions[0]` — the regex stops at `]`, so the captured path is
		// just `actions`. We don't synthesize array semantics from
		// bracket access today; that's a future enhancement.
		expect(result.body).toEqual({ user: { id: "string" }, actions: "string" });
	});
});

describe("inferSampleBody · forEach binds an array shape", () => {
	it("marks the `forEach.in` path as an array of objects", () => {
		const result = infer({
			steps: [
				{
					id: "fan",
					forEach: {
						in: "js/ctx.request.body.subscribers",
						as: "subscriber",
						do: [],
					},
				},
			],
		});
		expect(result.body).toEqual({ subscribers: [{}] });
	});

	it("propagates element fields through the `as` scope into the inferred array element", () => {
		const result = infer({
			steps: [
				{
					id: "fan",
					forEach: {
						in: "js/ctx.request.body.subscribers",
						as: "subscriber",
						do: [
							{
								id: "post",
								use: "@blokjs/api-call",
								inputs: {
									url: "js/ctx.state.subscriber.url",
									headers: { "X-Sub-Id": "js/ctx.state.subscriber.id" },
								},
							},
						],
					},
				},
			],
		});
		expect(result.body).toEqual({
			subscribers: [{ url: "string", id: "string" }],
		});
	});

	it("composes element-shape fields with sibling body references (the real v05-webhook-fanout shape)", () => {
		const result = infer({
			steps: [
				{
					id: "fan",
					forEach: {
						in: "js/ctx.request.body.subscribers",
						as: "subscriber",
						do: [
							{
								id: "post",
								use: "@blokjs/api-call",
								inputs: {
									url: "js/ctx.state.subscriber.url",
									body: "js/ctx.request.body.event",
									headers: {
										"X-Sub-Id": "js/ctx.state.subscriber.id",
										"X-Event-Id": "js/ctx.request.body.event.id",
									},
								},
							},
						],
					},
				},
				{
					id: "summary",
					use: "@blokjs/expr",
					inputs: { expression: "ctx.request.body.event.id" },
				},
			],
		});
		expect(result.body).toEqual({
			subscribers: [{ url: "string", id: "string" }],
			event: { id: "string" },
		});
	});
});

describe("inferSampleBody · branch / loop / switch / tryCatch", () => {
	it("collects references from `branch.when`, then-arm, and else-arm", () => {
		const result = infer({
			steps: [
				{
					id: "route",
					branch: {
						when: "js/ctx.request.body.action === 'create'",
						then: [{ id: "c", use: "n", inputs: { x: "js/ctx.request.body.create.name" } }],
						else: [{ id: "r", use: "n", inputs: { x: "js/ctx.request.body.read.id" } }],
					},
				},
			],
		});
		expect(result.body).toEqual({
			action: "string",
			create: { name: "string" },
			read: { id: "string" },
		});
	});

	it("collects from `loop.while` and the loop body", () => {
		const result = infer({
			steps: [
				{
					id: "pull",
					loop: {
						while: "js/ctx.request.body.maxIterations > ctx.state.count",
						do: [{ id: "fetch", use: "n", inputs: { url: "js/ctx.request.body.endpoint" } }],
					},
				},
			],
		});
		expect(result.body).toEqual({ maxIterations: "string", endpoint: "string" });
	});

	it("collects from `switch.on`, every case, and the default", () => {
		const result = infer({
			steps: [
				{
					id: "kind",
					switch: {
						on: "js/ctx.request.body.kind",
						cases: [
							{ when: "user", do: [{ id: "u", use: "n", inputs: { x: "js/ctx.request.body.user.id" } }] },
							{ when: "post", do: [{ id: "p", use: "n", inputs: { x: "js/ctx.request.body.post.title" } }] },
						],
						default: [{ id: "d", use: "n", inputs: { x: "js/ctx.request.body.fallback.id" } }],
					},
				},
			],
		});
		expect(result.body).toEqual({
			kind: "string",
			user: { id: "string" },
			post: { title: "string" },
			fallback: { id: "string" },
		});
	});

	it("recurses into tryCatch try / catch / finally", () => {
		const result = infer({
			steps: [
				{
					id: "safe",
					tryCatch: {
						try: [{ id: "a", use: "n", inputs: { x: "js/ctx.request.body.try_field" } }],
						catch: [{ id: "b", use: "n", inputs: { x: "js/ctx.request.body.catch_field" } }],
						finally: [{ id: "c", use: "n", inputs: { x: "js/ctx.request.body.finally_field" } }],
					},
				},
			],
		});
		expect(result.body).toEqual({
			try_field: "string",
			catch_field: "string",
			finally_field: "string",
		});
	});
});

describe("inferSampleBody · defensive", () => {
	it("ignores steps with no inputs / no control-flow", () => {
		const result = infer({ steps: [{ id: "noop", use: "n" }] });
		expect(result.source).toBe("empty");
		expect(result.body).toEqual({});
	});

	it("ignores malformed step entries", () => {
		const result = infer({ steps: [null, "string", 42, []] });
		expect(result.source).toBe("empty");
	});

	it("treats forEach.in that's a literal array (not a body path) as no array binding", () => {
		const result = infer({
			steps: [
				{
					id: "fan",
					forEach: {
						in: [{ a: 1 }, { a: 2 }],
						as: "item",
						do: [{ id: "use", use: "n", inputs: { x: "js/ctx.state.item.value" } }],
					},
				},
			],
		});
		// The `as` binding doesn't resolve to a body path, so the
		// inner `ctx.state.item.value` reference doesn't contribute
		// to the inferred body.
		expect(result.body).toEqual({});
	});
});
