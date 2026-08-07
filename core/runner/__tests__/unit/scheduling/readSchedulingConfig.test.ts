import { describe, expect, it } from "vitest";
import { UnresolvableKeyExpressionError } from "../../../src/idempotency/resolveIdempotencyKey";
import { readSchedulingConfig } from "../../../src/scheduling/readSchedulingConfig";

describe("readSchedulingConfig — debounce.key (#706)", () => {
	it("reads a js/ expression and a deliberate literal unchanged", () => {
		expect(
			readSchedulingConfig({ http: { debounce: { key: "js/ctx.request.params.docId", delay: "500ms" } } })?.debounce
				?.keyExpression,
		).toBe("js/ctx.request.params.docId");
		expect(
			readSchedulingConfig({ http: { debounce: { key: "doc-1", delay: "500ms" } } })?.debounce?.keyExpression,
		).toBe("doc-1");
	});

	it("throws on an expression-shaped key instead of coalescing every document into one window", () => {
		expect(() => readSchedulingConfig({ http: { debounce: { key: "$.req.params.docId", delay: "500ms" } } })).toThrow(
			UnresolvableKeyExpressionError,
		);
	});

	it("throws on an unlowered {$ref} key instead of silently disabling debounce", () => {
		// This config is hand-built, so it BYPASSES `normalizeWorkflow` — which
		// since #707 lowers `debounce.key` and would hand this in as a `js/`
		// string. The raw object reaching the reader is the case this guard still
		// owns: it used to be coerced to "" and silently drop the gate.
		expect(() =>
			readSchedulingConfig({
				http: { debounce: { key: { $ref: { step: "@trigger", path: ["params", "docId"] } }, delay: "500ms" } },
			}),
		).toThrow(UnresolvableKeyExpressionError);
	});
});
