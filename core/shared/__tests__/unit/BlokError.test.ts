import { describe, expect, it } from "vitest";
import BlokError, {
	DEFAULT_HTTP_STATUS,
	DEFAULT_RETRYABLE,
	ErrorCategory,
	ErrorSeverity,
	type NodeErrorPayload,
} from "../../src/BlokError";
import GlobalError from "../../src/GlobalError";

describe("BlokError", () => {
	describe("factory methods", () => {
		const factories = [
			{ name: "validation", method: BlokError.validation, expected: ErrorCategory.VALIDATION },
			{ name: "configuration", method: BlokError.configuration, expected: ErrorCategory.CONFIGURATION },
			{ name: "dependency", method: BlokError.dependency, expected: ErrorCategory.DEPENDENCY },
			{ name: "timeout", method: BlokError.timeout, expected: ErrorCategory.TIMEOUT },
			{ name: "permission", method: BlokError.permission, expected: ErrorCategory.PERMISSION },
			{ name: "rateLimit", method: BlokError.rateLimit, expected: ErrorCategory.RATE_LIMIT },
			{ name: "notFound", method: BlokError.notFound, expected: ErrorCategory.NOT_FOUND },
			{ name: "conflict", method: BlokError.conflict, expected: ErrorCategory.CONFLICT },
			{ name: "cancelled", method: BlokError.cancelled, expected: ErrorCategory.CANCELLED },
			{ name: "internal", method: BlokError.internal, expected: ErrorCategory.INTERNAL },
			{ name: "protocol", method: BlokError.protocol, expected: ErrorCategory.PROTOCOL },
			{ name: "data", method: BlokError.data, expected: ErrorCategory.DATA },
		];

		for (const { name, method, expected } of factories) {
			it(`${name}() creates an error with the right category`, () => {
				const err = method({ code: "TEST", message: "test" });
				expect(err.category).toBe(expected);
				expect(err).toBeInstanceOf(BlokError);
				expect(err).toBeInstanceOf(GlobalError);
				expect(err).toBeInstanceOf(Error);
			});
		}

		it("each factory applies the default http_status for its category", () => {
			for (const { method, expected } of factories) {
				const err = method({ code: "TEST", message: "test" });
				expect(err.httpStatus).toBe(DEFAULT_HTTP_STATUS[expected]);
				expect(err.context.code).toBe(DEFAULT_HTTP_STATUS[expected]);
			}
		});

		it("each factory applies the default retryable hint for its category", () => {
			for (const { method, expected } of factories) {
				const err = method({ code: "TEST", message: "test" });
				expect(err.retryable).toBe(DEFAULT_RETRYABLE[expected]);
			}
		});

		it("defaults severity to ERROR", () => {
			const err = BlokError.dependency({ code: "X", message: "x" });
			expect(err.severity).toBe(ErrorSeverity.ERROR);
		});
	});

	describe("constructor options", () => {
		it("preserves all human-readable fields", () => {
			const err = BlokError.dependency({
				code: "POSTGRES_CONNECT_TIMEOUT",
				message: "Could not connect to Postgres within 5s",
				description: "Tried host=localhost port=5432; timeout=5000ms",
				remediation: "Check DATABASE_URL env var and network reachability",
				docUrl: "https://blok.dev/errors/POSTGRES_CONNECT_TIMEOUT",
			});

			expect(err.errorCode).toBe("POSTGRES_CONNECT_TIMEOUT");
			expect(err.message).toBe("Could not connect to Postgres within 5s");
			expect(err.description).toContain("port=5432");
			expect(err.remediation).toContain("DATABASE_URL");
			expect(err.docUrl).toContain("POSTGRES_CONNECT_TIMEOUT");
		});

		it("allows overriding httpStatus", () => {
			const err = BlokError.dependency({ code: "X", message: "x", httpStatus: 503 });
			expect(err.httpStatus).toBe(503);
			expect(err.context.code).toBe(503);
		});

		it("allows overriding retryable + retryAfterMs", () => {
			const err = BlokError.dependency({
				code: "X",
				message: "x",
				retryable: false,
				retryAfterMs: 0,
			});
			expect(err.retryable).toBe(false);
			expect(err.retryAfterMs).toBe(0);
		});

		it("allows overriding severity", () => {
			const err = BlokError.timeout({
				code: "X",
				message: "x",
				severity: ErrorSeverity.FATAL,
			});
			expect(err.severity).toBe(ErrorSeverity.FATAL);
		});

		it("captures structured details", () => {
			const err = BlokError.validation({
				code: "VALIDATION_FAILED",
				message: "schema mismatch",
				details: { issues: [{ path: "email", message: "invalid" }] },
			});
			expect(err.details).toEqual({ issues: [{ path: "email", message: "invalid" }] });
		});

		it("captures contextSnapshot", () => {
			const snapshot = { inputs: { foo: "bar" }, varsKeys: ["a", "b"] };
			const err = BlokError.internal({
				code: "OOPS",
				message: "oops",
				contextSnapshot: snapshot,
			});
			expect(err.contextSnapshot).toEqual(snapshot);
		});
	});

	describe("cause chain", () => {
		it("flattens a single Error cause", () => {
			const inner = new Error("connect ECONNREFUSED");
			const outer = BlokError.dependency({
				code: "DB_DOWN",
				message: "Database unreachable",
				cause: inner,
			});

			expect(outer.causes).toHaveLength(1);
			expect(outer.causes[0].message).toBe("connect ECONNREFUSED");
			expect(outer.causes[0].category).toBe(ErrorCategory.INTERNAL);
		});

		it("flattens a BlokError cause without re-wrapping its own causes", () => {
			const root = BlokError.timeout({ code: "DNS_TIMEOUT", message: "dns timed out" });
			const middle = BlokError.dependency({ code: "DB_DOWN", message: "db unreachable", cause: root });
			const top = BlokError.internal({ code: "REQUEST_FAILED", message: "request failed", cause: middle });

			expect(top.causes).toHaveLength(2);
			expect(top.causes[0].code).toBe("DB_DOWN");
			expect(top.causes[1].code).toBe("DNS_TIMEOUT");
		});

		it("returns an empty causes array when no cause is provided", () => {
			const err = BlokError.internal({ code: "X", message: "x" });
			expect(err.causes).toHaveLength(0);
		});

		it("does not infinite-loop on circular causes", () => {
			const a = new Error("a");
			const b = new Error("b");
			(a as Error & { cause?: Error }).cause = b;
			(b as Error & { cause?: Error }).cause = a;

			expect(() => BlokError.internal({ code: "CYCLE", message: "circular", cause: a })).not.toThrow();
		});
	});

	describe("GlobalError compatibility", () => {
		it("populates context.code with httpStatus", () => {
			const err = BlokError.notFound({ code: "USER_NOT_FOUND", message: "no user" });
			expect(err.context.code).toBe(404);
		});

		it("populates context.name with node when provided", () => {
			const err = BlokError.dependency({ code: "X", message: "x", node: "fetch-user" });
			expect(err.context.name).toBe("fetch-user");
		});

		it("populates context.json with the full payload", () => {
			const err = BlokError.dependency({
				code: "DB_DOWN",
				message: "db down",
				description: "host unreachable",
				remediation: "check network",
			});
			const payload = err.context.json as unknown as NodeErrorPayload;
			expect(payload.code).toBe("DB_DOWN");
			expect(payload.category).toBe(ErrorCategory.DEPENDENCY);
			expect(payload.description).toBe("host unreachable");
			expect(payload.remediation).toBe("check network");
		});
	});

	describe("toJSON / fromJSON round-trip", () => {
		it("preserves every field", () => {
			const inner = BlokError.timeout({
				code: "INNER_TIMEOUT",
				message: "inner timed out",
			});
			const original = BlokError.dependency({
				code: "DB_DOWN",
				message: "Database unreachable",
				description: "Tried host=db port=5432",
				remediation: "Check DATABASE_URL",
				docUrl: "https://blok.dev/errors/DB_DOWN",
				cause: inner,
				retryable: true,
				retryAfterMs: 5000,
				details: { sqlState: "08001" },
				contextSnapshot: { inputs: { query: "SELECT 1" } },
				httpStatus: 503,
				severity: ErrorSeverity.WARN,
				node: "store-tutorial",
				sdk: "blok-python3",
				sdkVersion: "1.0.0",
				runtimeKind: "runtime.python3",
			});

			const json = original.toJSON();
			const restored = BlokError.fromJSON(json);

			expect(restored.errorCode).toBe(original.errorCode);
			expect(restored.category).toBe(original.category);
			expect(restored.severity).toBe(original.severity);
			expect(restored.message).toBe(original.message);
			expect(restored.description).toBe(original.description);
			expect(restored.remediation).toBe(original.remediation);
			expect(restored.docUrl).toBe(original.docUrl);
			expect(restored.retryable).toBe(original.retryable);
			expect(restored.retryAfterMs).toBe(original.retryAfterMs);
			expect(restored.details).toEqual(original.details);
			expect(restored.contextSnapshot).toEqual(original.contextSnapshot);
			expect(restored.httpStatus).toBe(original.httpStatus);
			expect(restored.nodeName).toBe(original.nodeName);
			expect(restored.sdk).toBe(original.sdk);
			expect(restored.sdkVersion).toBe(original.sdkVersion);
			expect(restored.runtimeKind).toBe(original.runtimeKind);
			expect(restored.causes).toEqual(original.causes);
		});

		it("toJSON produces an ISO timestamp for `at`", () => {
			const err = BlokError.internal({ code: "X", message: "x" });
			const json = err.toJSON();
			expect(json.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(new Date(json.at).getTime()).not.toBeNaN();
		});
	});

	describe("fromUnknown", () => {
		it("passes BlokError through unchanged", () => {
			const original = BlokError.dependency({ code: "X", message: "x" });
			const wrapped = BlokError.fromUnknown(original);
			expect(wrapped).toBe(original);
		});

		it("wraps a plain Error as INTERNAL with UNCAUGHT_<NAME> code", () => {
			const err = new TypeError("bad type");
			const wrapped = BlokError.fromUnknown(err);
			expect(wrapped.category).toBe(ErrorCategory.INTERNAL);
			expect(wrapped.errorCode).toBe("UNCAUGHT_TYPEERROR");
			expect(wrapped.message).toBe("bad type");
			expect(wrapped.causes).toHaveLength(1);
		});

		it("wraps a string as INTERNAL/UNCAUGHT_ERROR", () => {
			const wrapped = BlokError.fromUnknown("oops");
			expect(wrapped.category).toBe(ErrorCategory.INTERNAL);
			expect(wrapped.errorCode).toBe("UNCAUGHT_ERROR");
			expect(wrapped.message).toBe("oops");
		});

		it("wraps a non-Error value as INTERNAL/UNCAUGHT_ERROR with stringified message", () => {
			const wrapped = BlokError.fromUnknown({ weird: true });
			expect(wrapped.category).toBe(ErrorCategory.INTERNAL);
			expect(wrapped.errorCode).toBe("UNCAUGHT_ERROR");
			expect(wrapped.message).toContain("weird");
		});

		it("preserves a pre-existing GlobalError code and json", () => {
			const ge = new GlobalError("legacy");
			ge.setCode(403);
			ge.setJson({ origin: "auth" });
			const wrapped = BlokError.fromUnknown(ge);
			expect(wrapped.httpStatus).toBe(403);
			expect(wrapped.details).toEqual({ origin: "auth" });
		});

		it("uses ctx overrides for node/sdk/sdkVersion/runtimeKind", () => {
			const wrapped = BlokError.fromUnknown(new Error("x"), {
				node: "step-1",
				sdk: "blok-go",
				sdkVersion: "1.0.0",
				runtimeKind: "runtime.go",
			});
			expect(wrapped.nodeName).toBe("step-1");
			expect(wrapped.sdk).toBe("blok-go");
			expect(wrapped.sdkVersion).toBe("1.0.0");
			expect(wrapped.runtimeKind).toBe("runtime.go");
		});
	});
});
