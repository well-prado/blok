import { describe, expect, it } from "vitest";
import { MapperResolutionError } from "../../../src/utils/MapperResolutionError";

describe("MapperResolutionError", () => {
	it("constructs with name 'MapperResolutionError'", () => {
		const e = new MapperResolutionError("msg", { expression: "x", syntax: "js" });
		expect(e.name).toBe("MapperResolutionError");
	});

	it("preserves the prototype chain across `instanceof` checks", () => {
		const e = new MapperResolutionError("msg", { expression: "x", syntax: "js" });
		expect(e instanceof MapperResolutionError).toBe(true);
		expect(e instanceof Error).toBe(true);
	});

	it("carries the structured context object verbatim", () => {
		const cause = new TypeError("boom");
		const e = new MapperResolutionError("msg", {
			expression: "ctx.req.body.id",
			syntax: "js",
			workflowName: "wf-1",
			stepName: "step-2",
			cause,
		});
		expect(e.context.expression).toBe("ctx.req.body.id");
		expect(e.context.syntax).toBe("js");
		expect(e.context.workflowName).toBe("wf-1");
		expect(e.context.stepName).toBe("step-2");
		expect(e.context.cause).toBe(cause);
	});

	it("attaches Error.cause when context.cause is provided (ES2022 cause-chain)", () => {
		const cause = new Error("underlying");
		const e = new MapperResolutionError("msg", { expression: "x", syntax: "js", cause });
		// `cause` is set on the Error instance per spec.
		expect((e as Error & { cause?: unknown }).cause).toBe(cause);
	});

	it("does NOT set Error.cause when context.cause is omitted", () => {
		const e = new MapperResolutionError("msg", { expression: "x", syntax: "js" });
		expect((e as Error & { cause?: unknown }).cause).toBeUndefined();
	});

	it("supports both syntax discriminators (js + template)", () => {
		const a = new MapperResolutionError("msg", { expression: "ctx.x", syntax: "js" });
		const b = new MapperResolutionError("msg", { expression: "ctx.x", syntax: "template" });
		expect(a.context.syntax).toBe("js");
		expect(b.context.syntax).toBe("template");
	});

	it("captures the original message verbatim (multi-line OK)", () => {
		const msg = "[blok][mapper] Failed to resolve `js/x`\n  underlying: bad\n  hint: try this";
		const e = new MapperResolutionError(msg, { expression: "x", syntax: "js" });
		expect(e.message).toBe(msg);
	});

	it("makes context fields readonly at the type level (compile-time check)", () => {
		// This test exists for documentation — TS rejects mutation on
		// `readonly` fields at compile time. At runtime, the object
		// is plain. We assert the shape, not enforcement.
		const e = new MapperResolutionError("msg", { expression: "x", syntax: "js" });
		expect(Object.isFrozen(e.context)).toBe(false); // readonly is type-level only
	});
});
