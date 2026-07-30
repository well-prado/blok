import { GlobalError } from "@blokjs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseWorkflowInput, shouldRunInputGate } from "../../../src/workflow/validateWorkflowInput";

describe("parseWorkflowInput (ADR 0015)", () => {
	const schema = z.object({
		query: z.string(),
		page: z.number().default(1),
	});

	it("returns the body untouched when no schema is declared", () => {
		const body = { anything: true };
		expect(parseWorkflowInput(undefined, body)).toBe(body);
	});

	it("applies Zod defaults + strips unknown keys on success", () => {
		const parsed = parseWorkflowInput(schema, { query: "hi", extra: "dropped" });
		expect(parsed).toEqual({ query: "hi", page: 1 });
	});

	it("coerces per the schema on success", () => {
		const coercing = z.object({ n: z.coerce.number() });
		expect(parseWorkflowInput(coercing, { n: "42" })).toEqual({ n: 42 });
	});

	it("throws a GlobalError(400) with a structured validation_errors body on failure", () => {
		try {
			parseWorkflowInput(schema, { page: "not-a-number" });
			throw new Error("expected parseWorkflowInput to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(GlobalError);
			const ge = err as GlobalError;
			expect(ge.context.code).toBe(400);
			const body = ge.context.json as { validation_errors: Array<{ path: unknown[]; code: string }> };
			const paths = body.validation_errors.map((e) => e.path.join("."));
			expect(paths).toContain("query"); // missing required
			expect(paths).toContain("page"); // wrong type
		}
	});
});

describe("shouldRunInputGate (ADR 0015 gate decision)", () => {
	// invokingTriggerValidates comes from the INVOKING trigger's
	// validatesDeclaredInput() (true only for http/mcp/grpc), NOT the declared
	// trigger config — so a multi-trigger `{ http, worker }` workflow fired via
	// worker passes false here and is not validated against job.data.
	const base = { hasRequest: true, isReentry: false, killSwitch: undefined, invokingTriggerValidates: true };

	it("runs for a first-pass request from a validating trigger with the kill switch off", () => {
		expect(shouldRunInputGate(base)).toBe(true);
	});

	it("SKIPS on deferred re-entry (body already validated on the first pass)", () => {
		// The MAJOR audit defect: re-parsing a transformed body double-applies or 400s post-202.
		expect(shouldRunInputGate({ ...base, isReentry: true })).toBe(false);
	});

	it("SKIPS when the invoking trigger does not validate (worker/cron/pubsub, or worker side of a multi-trigger)", () => {
		expect(shouldRunInputGate({ ...base, invokingTriggerValidates: false })).toBe(false);
	});

	it("SKIPS when there is no request, or the kill switch is set", () => {
		expect(shouldRunInputGate({ ...base, hasRequest: false })).toBe(false);
		expect(shouldRunInputGate({ ...base, killSwitch: "0" })).toBe(false);
	});
});
