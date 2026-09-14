/**
 * #1011 tests 1–2 — `@blokjs/validate`'s dot-path error keys.
 *
 * The whole reason this node exists is that Inertia's `errors` prop is keyed by
 * dot path and a `ZodError` is keyed by an array of segments. These drive the
 * real node through `runNode` (its own Zod in/out path) rather than calling the
 * mapper directly, so a schema regression fails here too.
 */

import { runNode } from "@blokjs/runner/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import ValidateNode from "../src/validate";

const nested = z.object({ user: z.object({ name: z.string().min(1, "Required.") }) });
const arrays = z.object({ items: z.array(z.object({ name: z.string().min(1, "Required.") })) });

describe("@blokjs/validate (#1011)", () => {
	// Test 1
	it("1 — a nested field fails under its dot path, as a string by default", async () => {
		const out = await runNode(ValidateNode, { schema: nested, data: { user: { name: "" } } });
		expect(out.ok).toBe(false);
		expect(out.errors["user.name"]).toBe("Required.");
		expect(typeof out.errors["user.name"]).toBe("string");
		expect(out.data).toBeUndefined();
	});

	// Test 1 (withAllErrors)
	it("1 — `withAllErrors` turns every key into the full message array", async () => {
		const strict = z.object({
			user: z.object({
				name: z
					.string()
					.min(3, "Too short.")
					.regex(/^[a-z]+$/, "Letters only."),
			}),
		});
		const out = await runNode(ValidateNode, {
			schema: strict,
			data: { user: { name: "A1" } },
			withAllErrors: true,
		});
		expect(out.ok).toBe(false);
		expect(out.errors["user.name"]).toEqual(["Too short.", "Letters only."]);
	});

	// Test 2
	it("2 — an array element fails under `items.0.name`", async () => {
		const out = await runNode(ValidateNode, {
			schema: arrays,
			data: { items: [{ name: "ok" }, { name: "" }] },
		});
		expect(Object.keys(out.errors)).toEqual(["items.1.name"]);
		expect(out.errors["items.1.name"]).toBe("Required.");

		const first = await runNode(ValidateNode, { schema: arrays, data: { items: [{ name: "" }] } });
		expect(first.errors["items.0.name"]).toBe("Required.");
	});

	it("returns the PARSED value and no errors when the payload is valid", async () => {
		const out = await runNode(ValidateNode, {
			schema: z.object({ qty: z.coerce.number() }),
			data: { qty: "3" },
		});
		expect(out.ok).toBe(true);
		expect(out.errors).toEqual({});
		expect(out.data).toEqual({ qty: 3 });
	});

	it("never throws on invalid input — the failure is data, not an exception", async () => {
		const out = await runNode(ValidateNode, { schema: nested, data: null });
		expect(out.ok).toBe(false);
		expect(Object.keys(out.errors).length).toBeGreaterThan(0);
	});

	it("keys a root-level refinement under `_`", async () => {
		const schema = z.object({ a: z.number(), b: z.number() }).refine((v) => v.a < v.b, "a must be below b");
		const out = await runNode(ValidateNode, { schema, data: { a: 2, b: 1 } });
		expect(out.errors._).toBe("a must be below b");
	});

	// The JSON-workflow path: the same dot-path keys out of a plain JSON Schema.
	it("accepts a JSON Schema and produces the SAME dot-path keys", async () => {
		const schema = {
			type: "object",
			properties: {
				user: { type: "object", properties: { name: { type: "string", minLength: 1 } }, required: ["name"] },
				items: { type: "array", items: { type: "object", properties: { name: { type: "string", minLength: 1 } } } },
			},
			required: ["user"],
		};
		const out = await runNode(ValidateNode, {
			schema,
			data: { user: {}, items: [{ name: "" }] },
		});
		expect(out.ok).toBe(false);
		expect(out.errors["user.name"]).toContain("required");
		expect(out.errors["items.0.name"]).toContain("1 character");
	});

	it("rejects a `schema` that is neither Zod nor an object", async () => {
		await expect(runNode(ValidateNode, { schema: "nope", data: {} })).rejects.toThrow(
			/must be a Zod schema value or a JSON Schema object/,
		);
	});
});
