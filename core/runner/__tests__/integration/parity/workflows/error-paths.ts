import { BlokError } from "@blokjs/shared";
import { expect } from "vitest";
import { type CanonicalWorkflow, asBlokError } from "./types";

/**
 * Cross-language verification that the §17 BlokError builder API produces
 * byte-identical proto envelopes regardless of SDK. Every SDK that ships
 * `blok-error-demo` triggers the same three categories
 * (DEPENDENCY/RATE_LIMIT/VALIDATION) with the same code, message,
 * remediation, http_status, retryable, retry_after_ms, details, doc_url,
 * and cause-chain shape.
 *
 * Closes the §17.13 "byte-identical NodeError parity" requirement at the
 * matrix level — each SDK's per-language E2E asserts the fields, the
 * matrix asserts every SDK converges on the same fields.
 *
 * The three modes mirror the demo nodes shipped in
 * `sdks/{python3,go,rust,java,csharp,ruby,php}/.../BlokErrorDemoNode.{py,go,rs,java,cs,rb,php}`.
 */

export const errorDependencyWorkflow: CanonicalWorkflow = {
	id: "error-dependency",
	description: "BlokError::dependency() flows through with cause chain + retry hints",
	node: "blok-error-demo",
	stepName: "step-dep",
	inputs: { mode: "dependency" },
	body: {},
	expectSuccess: false,
	assertResult(result) {
		expect(result.success).toBe(false);
		expect(result.errors).toBeInstanceOf(BlokError);
		const err = asBlokError(result.errors);

		expect(err.errorCode).toBe("POSTGRES_CONNECT_TIMEOUT");
		expect(err.category).toBe("DEPENDENCY");
		expect(err.severity).toBe("ERROR");
		expect(err.message).toBe("Could not connect to Postgres within 5s");
		expect(err.description).toContain("host=db.internal");
		expect(err.remediation).toContain("DATABASE_URL");
		expect(err.docUrl).toBe("https://docs.example.com/errors/POSTGRES_CONNECT_TIMEOUT");
		expect(err.httpStatus).toBe(502);
		expect(err.retryable).toBe(true);
		expect(err.retryAfterMs).toBe(5_000);
		expect(err.details).toEqual({ host: "db.internal", port: 5432, timeout_ms: 5000 });
		expect(err.causes.length).toBeGreaterThan(0);
		// All SDKs root the cause chain in their language's
		// network/connection-refused exception type, but the message string
		// is identical: `[Errno 61] Connection refused`.
		expect(err.causes[0].message).toContain("Connection refused");
	},
};

export const errorRateLimitWorkflow: CanonicalWorkflow = {
	id: "error-rate-limit",
	description: "BlokError::rate_limit() carries retry_after_ms + structured details",
	node: "blok-error-demo",
	stepName: "step-rl",
	inputs: { mode: "rate-limit" },
	body: {},
	expectSuccess: false,
	assertResult(result) {
		expect(result.success).toBe(false);
		const err = asBlokError(result.errors);
		expect(err.errorCode).toBe("UPSTREAM_RATE_LIMITED");
		expect(err.category).toBe("RATE_LIMIT");
		expect(err.httpStatus).toBe(429);
		expect(err.retryable).toBe(true);
		expect(err.retryAfterMs).toBe(60_000);
		expect(err.details).toEqual({ limit: 5000, remaining: 0 });
	},
};

export const errorValidationWorkflow: CanonicalWorkflow = {
	id: "error-validation",
	description: "BlokError::validation() maps to 400 with non-retryable + structured issues",
	node: "blok-error-demo",
	stepName: "step-val",
	inputs: { mode: "validation" },
	body: {},
	expectSuccess: false,
	assertResult(result) {
		expect(result.success).toBe(false);
		const err = asBlokError(result.errors);
		expect(err.errorCode).toBe("VALIDATION_FAILED");
		expect(err.category).toBe("VALIDATION");
		expect(err.httpStatus).toBe(400);
		expect(err.retryable).toBe(false);
		const details = err.details as { issues: { path: string[]; message: string }[] };
		expect(details.issues).toHaveLength(2);
		expect(details.issues[0].path).toEqual(["email"]);
		expect(details.issues[0].message).toBe("Required");
	},
};

/**
 * The full error-path battery (3 categories — Dependency / RateLimit /
 * Validation) every SDK runs. Adding a new category to the demo node and
 * appending it here is the canonical way to expand §17.13 coverage.
 */
export const errorPathsBattery: ReadonlyArray<CanonicalWorkflow> = [
	errorDependencyWorkflow,
	errorRateLimitWorkflow,
	errorValidationWorkflow,
];
