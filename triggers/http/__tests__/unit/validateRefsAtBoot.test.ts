import { describe, expect, it } from "vitest";
import { collectBootRefErrors, readRefValidationMode, reportRefsAtBoot } from "../../src/runner/validateRefsAtBoot";

// #691 — boot-time schema-aware `$ref` validation. Advisory by default,
// `BLOK_VALIDATE_REFS=strict` fails boot, `=off` silences it.

const projector = {
	name: "projector",
	ref: "projector",
	outputSchema: {
		type: "object",
		properties: { eventsApplied: { type: "number" } },
		additionalProperties: false,
	},
};

const brokenWorkflow = {
	name: "ingest",
	source: "workflows/json/ingest.json",
	workflow: {
		name: "ingest",
		version: "1.0.0",
		steps: [
			{ id: "project", use: "projector", inputs: {} },
			{ id: "respond", use: "projector", inputs: { v: { $ref: { step: "project", path: ["readModelServed"] } } } },
		],
	},
};

function recorder() {
	const logs: string[] = [];
	const errors: string[] = [];
	return { logs, errors, log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) };
}

describe("readRefValidationMode", () => {
	it("defaults to advisory and recognises strict / off", () => {
		expect(readRefValidationMode(undefined)).toBe("advisory");
		expect(readRefValidationMode("")).toBe("advisory");
		expect(readRefValidationMode("warn")).toBe("advisory");
		expect(readRefValidationMode("strict")).toBe("strict");
		expect(readRefValidationMode("off")).toBe("off");
		expect(readRefValidationMode("0")).toBe("off");
	});
});

describe("collectBootRefErrors", () => {
	it("names the source, the doc path and the diagnostic code", () => {
		const result = collectBootRefErrors([brokenWorkflow], [projector]);
		expect(result.errorLines).toHaveLength(1);
		expect(result.errorLines[0]).toContain("workflows/json/ingest.json");
		expect(result.errorLines[0]).toContain("[unknown-field]");
		expect(result.errorLines[0]).toContain("readModelServed");
		expect(result.workflowCount).toBe(1);
	});

	it("degrades to zero errors when no node advertises a schema", () => {
		const result = collectBootRefErrors([brokenWorkflow], []);
		expect(result.errorLines).toEqual([]);
		expect(result.uncheckedStepCount).toBe(2);
	});

	it("does not flag state a middleware workflow in the registry writes", () => {
		const result = collectBootRefErrors(
			[
				{
					name: "auth-check",
					source: "middleware/auth-check.json",
					workflow: {
						name: "auth-check",
						middleware: true,
						steps: [{ id: "stash", use: "@blokjs/ctx-publish", inputs: { name: "identity", value: 1 } }],
					},
				},
				{
					name: "guarded",
					source: "guarded.json",
					workflow: {
						name: "guarded",
						steps: [{ id: "respond", use: "projector", inputs: { v: "js/ctx.state.identity" } }],
					},
				},
			],
			[projector],
		);
		expect(result.errorLines).toEqual([]);
	});
});

describe("reportRefsAtBoot", () => {
	it("logs and continues in advisory mode", () => {
		const log = recorder();
		const result = collectBootRefErrors([brokenWorkflow], [projector]);
		expect(() => reportRefsAtBoot(result, "advisory", log)).not.toThrow();
		expect(log.errors[0]).toContain("1 step-output reference error(s)");
		expect(log.errors[0]).toContain("BLOK_VALIDATE_REFS=strict");
	});

	it("throws in strict mode", () => {
		const log = recorder();
		const result = collectBootRefErrors([brokenWorkflow], [projector]);
		expect(() => reportRefsAtBoot(result, "strict", log)).toThrow(/refusing to boot/);
	});

	it("says nothing in off mode, or when there is nothing to say", () => {
		const log = recorder();
		const result = collectBootRefErrors([brokenWorkflow], [projector]);
		reportRefsAtBoot(result, "off", log);
		expect(log.errors).toEqual([]);
		reportRefsAtBoot(collectBootRefErrors([], []), "strict", log);
		expect(log.errors).toEqual([]);
	});
});
