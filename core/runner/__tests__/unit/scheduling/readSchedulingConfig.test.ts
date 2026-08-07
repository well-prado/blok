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
		// `lowerRefs` runs over step `inputs` only, so a structural ref here never
		// becomes a `js/` string — it used to be coerced to "" and drop the gate.
		expect(() =>
			readSchedulingConfig({
				http: { debounce: { key: { $ref: { step: "@trigger", path: ["params", "docId"] } }, delay: "500ms" } },
			}),
		).toThrow(UnresolvableKeyExpressionError);
	});
});
