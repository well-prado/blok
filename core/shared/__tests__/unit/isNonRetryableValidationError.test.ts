import { describe, expect, it } from "vitest";
import BlokError, { WORKFLOW_INPUT_VALIDATION, isNonRetryableValidationError } from "../../src/BlokError";
import GlobalError from "../../src/GlobalError";

describe("isNonRetryableValidationError (ADR 0015)", () => {
	it("matches the input gate's tagged GlobalError", () => {
		const err = new GlobalError("Input validation failed: query (Required)");
		err.setCode(400);
		err.setName(WORKFLOW_INPUT_VALIDATION);
		expect(isNonRetryableValidationError(err)).toBe(true);
	});

	it("does NOT match a node's BlokError.validation (only the gate's tagged error is terminal)", () => {
		// Narrow by design: node-level validation keeps its existing retry handling,
		// and its serialized stack/contextSnapshot is never surfaced by the webhook.
		const err = BlokError.validation({ code: "BAD_INPUT", message: "nope" });
		expect(isNonRetryableValidationError(err)).toBe(false);
	});

	it("does NOT match a plain 400 GlobalError without the tag (avoids over-matching arbitrary 4xx)", () => {
		const err = new GlobalError("some business 400");
		err.setCode(400);
		expect(isNonRetryableValidationError(err)).toBe(false);
	});

	it("does NOT match any BlokError category (dependency/validation/not-found/…)", () => {
		expect(isNonRetryableValidationError(BlokError.dependency({ code: "X", message: "m" }))).toBe(false);
		expect(isNonRetryableValidationError(BlokError.validation({ code: "X", message: "m" }))).toBe(false);
		expect(isNonRetryableValidationError(BlokError.notFound({ code: "X", message: "m" }))).toBe(false);
	});

	it("does NOT match plain Errors or non-errors", () => {
		expect(isNonRetryableValidationError(new Error("boom"))).toBe(false);
		expect(isNonRetryableValidationError("nope")).toBe(false);
		expect(isNonRetryableValidationError(undefined)).toBe(false);
	});
});
