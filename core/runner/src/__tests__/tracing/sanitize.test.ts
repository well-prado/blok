import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sanitize } from "../../tracing/sanitize";

describe("sanitize", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("should pass through null and undefined", () => {
		expect(sanitize(null)).toBeNull();
		expect(sanitize(undefined)).toBeUndefined();
	});

	it("should pass through primitives inside objects", () => {
		const input = { name: "test", count: 42, active: true };
		expect(sanitize(input)).toEqual(input);
	});

	it("should redact sensitive fields", () => {
		const input = {
			username: "john",
			password: "secret123",
			token: "abc",
			api_key: "key123",
			data: "safe",
		};

		const result = sanitize(input) as Record<string, unknown>;
		expect(result.username).toBe("john");
		expect(result.password).toBe("[REDACTED]");
		expect(result.token).toBe("[REDACTED]");
		expect(result.api_key).toBe("[REDACTED]");
		expect(result.data).toBe("safe");
	});

	it("should redact case-insensitively", () => {
		const input = { PASSWORD: "x", Token: "y", API_KEY: "z" };
		const result = sanitize(input) as Record<string, unknown>;
		expect(result.PASSWORD).toBe("[REDACTED]");
		expect(result.Token).toBe("[REDACTED]");
		expect(result.API_KEY).toBe("[REDACTED]");
	});

	it("should handle nested objects", () => {
		const input = {
			user: {
				name: "test",
				config: {
					password: "hidden",
					apikey: "hidden",
				},
			},
		};

		const result = sanitize(input) as Record<string, Record<string, Record<string, unknown>>>;
		expect(result.user.name).toBe("test");
		expect(result.user.config.password).toBe("[REDACTED]");
		expect(result.user.config.apikey).toBe("[REDACTED]");
	});

	it("should handle arrays", () => {
		const input = [{ password: "x" }, { name: "y" }];
		const result = sanitize(input) as Record<string, unknown>[];
		expect(result[0].password).toBe("[REDACTED]");
		expect(result[1].name).toBe("y");
	});

	it("should truncate large payloads", () => {
		// Set max to 1KB for testing
		process.env.BLOK_TRACE_PAYLOAD_MAX_KB = "1";
		const largeData = { data: "x".repeat(2000) };

		const result = sanitize(largeData) as Record<string, unknown>;
		expect(result._truncated).toBe(true);
		expect(result._originalSize).toBeGreaterThan(1024);
	});

	it("does not copy an oversized payload just to preview it", () => {
		// The freeze: an oversized payload was structurally copied in full before
		// anyone checked its size, so a big step aggregate cost millions of
		// throwaway allocations — and all but 500 chars of it was discarded.
		//
		// `toJSON` separates the two walks: JSON.stringify calls it and never sees
		// the getter, while the redaction copy enumerates properties and does. So
		// `copied` counts ONLY elements the redaction walk touched, which must now
		// stop at the preview budget instead of running to 5000.
		process.env.BLOK_TRACE_PAYLOAD_MAX_KB = "1";
		let copied = 0;
		const big = Array.from({ length: 5000 }, (_, i) => ({
			get body() {
				copied++;
				return "x".repeat(20);
			},
			toJSON() {
				return { i, body: "x".repeat(20) };
			},
		}));

		const result = sanitize(big) as Record<string, unknown>;
		expect(result._truncated).toBe(true);
		expect(result._originalSize).toBeGreaterThan(1024);
		expect(copied).toBeLessThan(1000);
	});

	it("redacts the preview of an oversized payload", () => {
		// The preview is the one part of an oversized payload that survives into
		// storage, so it must never carry a raw secret.
		process.env.BLOK_TRACE_PAYLOAD_MAX_KB = "1";
		const result = sanitize({ password: "hunter2", data: "x".repeat(4000) }) as Record<string, unknown>;

		expect(result._truncated).toBe(true);
		expect(result._preview).toContain("[REDACTED]");
		expect(result._preview).not.toContain("hunter2");
	});

	it("should add custom sensitive fields from env", () => {
		process.env.BLOK_TRACE_SANITIZE_FIELDS = "ssn,credit_card";
		const input = { ssn: "123-45-6789", credit_card: "4111", name: "John" };

		const result = sanitize(input) as Record<string, unknown>;
		expect(result.ssn).toBe("[REDACTED]");
		expect(result.credit_card).toBe("[REDACTED]");
		expect(result.name).toBe("John");
	});

	it("should handle circular reference gracefully", () => {
		const obj: Record<string, unknown> = { a: 1 };
		obj.self = obj;

		// Should not throw, returns error marker
		const result = sanitize(obj);
		expect(result).toBeDefined();
	});

	it("should redact OAuth/JWT/CSRF field names (security review FW-8)", () => {
		const input = {
			bearer: "abc",
			bearer_token: "abc",
			jwt: "eyJ...",
			csrf: "tok",
			csrftoken: "tok",
			csrf_token: "tok",
			oauth: "tok",
			oauth_token: "tok",
			tokenizer_config: "kept",
		};

		const result = sanitize(input) as Record<string, unknown>;
		expect(result.bearer).toBe("[REDACTED]");
		expect(result.bearer_token).toBe("[REDACTED]");
		expect(result.jwt).toBe("[REDACTED]");
		expect(result.csrf).toBe("[REDACTED]");
		expect(result.csrftoken).toBe("[REDACTED]");
		expect(result.csrf_token).toBe("[REDACTED]");
		expect(result.oauth).toBe("[REDACTED]");
		expect(result.oauth_token).toBe("[REDACTED]");
		// Substring matching is intentionally NOT applied — fields whose
		// name happens to contain a sensitive substring (tokenizer_config,
		// password_strength) are kept as-is to avoid false positives.
		expect(result.tokenizer_config).toBe("kept");
	});
});

/**
 * #1018 security review B1/B2 — exact-set membership leaked by SPELLING.
 *
 * `password` was redacted; `passwordConfirmation`, the field the auth kit's
 * sign-up form posts, was written to `.blok/trace.db` in plaintext. `cookie`
 * was redacted; `cookies` — the `RespondEnvelope` key carrying the signed
 * `blok_session` value — was not.
 */
describe("sanitize — sensitive keys are matched by substring (#1018 B1/B2)", () => {
	const SECRET = "plaintext-value-that-must-never-be-stored";

	it.each([
		"passwordConfirmation",
		"password_confirmation",
		"currentPassword",
		"newPassword",
		"passwd",
		"cookies",
		"setCookie",
		"set-cookie",
		"accessToken",
		"refreshToken",
		"clientSecret",
		"apiKeyHeader",
	])("redacts %s", (field) => {
		const result = sanitize({ [field]: SECRET }) as Record<string, unknown>;
		expect(result[field]).toBe("[REDACTED]");
	});

	it("redacts the whole shape a register step actually carries", () => {
		const body = {
			name: "Ada",
			email: "ada@example.com",
			password: SECRET,
			passwordConfirmation: SECRET,
		};
		const envelope = { body, cookies: [`blok_session=${SECRET}; HttpOnly`] };

		expect(JSON.stringify(sanitize(envelope))).not.toContain(SECRET);
	});

	/**
	 * The ambiguous short names stay EXACT-match, or a substring rule redacts
	 * `monkey`, `author` and `sessionCount` into uselessness.
	 */
	it.each(["monkey", "author", "sessionCount", "keyboard", "authorName"])("does not redact %s", (field) => {
		const result = sanitize({ [field]: "visible" }) as Record<string, unknown>;
		expect(result[field]).toBe("visible");
	});

	it("extends BLOK_TRACE_SANITIZE_FIELDS by word too", () => {
		process.env.BLOK_TRACE_SANITIZE_FIELDS = "pin";
		const result = sanitize({ pinCode: "1234", pin: "1234", spinner: "x" }) as Record<string, unknown>;
		expect(result.pin).toBe("[REDACTED]");
		expect(result.pinCode).toBe("[REDACTED]");
		// A WORD, not a substring: `spinner` is not a pin.
		expect(result.spinner).toBe("x");
	});

	/**
	 * The earlier FW-8 decision, kept: a raw `includes` rule would redact
	 * `tokenizer_config` and make traces useless. The word rule is what lets
	 * both reviews hold at once.
	 */
	it("still keeps a field that merely CONTAINS a stem inside a longer word", () => {
		const result = sanitize({ tokenizer_config: "kept", monkeyKey: "kept" }) as Record<string, unknown>;
		expect(result.tokenizer_config).toBe("kept");
	});
});
