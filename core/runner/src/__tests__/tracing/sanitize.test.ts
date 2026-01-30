import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
});
