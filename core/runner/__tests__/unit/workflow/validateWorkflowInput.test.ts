import { GlobalError, WORKFLOW_INPUT_VALIDATION, WorkflowInputValidationError } from "@blokjs/shared";
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

	it("throws a WorkflowInputValidationError(400) naming the workflow, with a structured body", () => {
		try {
			parseWorkflowInput(schema, { page: "not-a-number" }, "search_tool");
			throw new Error("expected parseWorkflowInput to throw");
		} catch (err) {
			// The named class is the author-facing `instanceof` surface…
			expect(err).toBeInstanceOf(WorkflowInputValidationError);
			// …and it stays a GlobalError so every transport translation is unchanged.
			expect(err).toBeInstanceOf(GlobalError);
			const ge = err as WorkflowInputValidationError;
			expect(ge.context.code).toBe(400);
			// The tag `isNonRetryableValidationError` matches (worker/pubsub/webhook routing).
			expect(ge.context.name).toBe(WORKFLOW_INPUT_VALIDATION);
			expect(ge.info.workflowName).toBe("search_tool");
			expect(ge.message).toContain("search_tool");
			const body = ge.context.json as {
				workflowName: string;
				validation_errors: Array<{ path: unknown[]; code: string }>;
			};
			expect(body.workflowName).toBe("search_tool");
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
