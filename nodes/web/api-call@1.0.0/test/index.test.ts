/**
 * API Call Node Tests - Updated for Function-First Implementation
 *
 * Tests migrated from class-based to function-first pattern.
 * All existing behavior is preserved.
 */

import type { IBlokResponse } from "@blok/runner";
import type { Context } from "@blok/shared";
import type { GlobalError } from "@blok/shared";
import { describe, expect, it, vi } from "vitest";
import ApiCallNode from "../index";
import { runApiCall } from "../util";

// Mock the util function
vi.mock("../util", () => ({
	runApiCall: vi.fn(),
}));

describe("ApiCall Node - Function-First", () => {
	const mockContext: Context = {
		id: "test-id",
		workflow_name: "test-workflow",
		workflow_path: "/test",
		request: {
			method: "POST",
			body: { default: "data" },
			headers: {},
			params: {},
			query: {},
		},
		response: {
			data: {},
			success: true,
			error: null,
		},
		error: {
			message: [],
		},
		vars: {},
		config: {
			"api-call": {}, // Node configuration
		},
		logger: {
			log: vi.fn(),
			info: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
		},
		env: {},
		eventLogger: null,
		_PRIVATE_: null,
	} as unknown as Context;

	const validInputs = {
		method: "GET",
		url: "https://api.example.com",
		headers: { Authorization: "Bearer token" },
		responseType: "json",
		body: { key: "value" },
	};

	it("should successfully make an API call and return response", async () => {
		const mockResult = { success: true, data: { message: "API Response" } };

		// Mock the API call
		vi.mocked(runApiCall).mockResolvedValue(mockResult);

		// Execute the node using handle()
		const result = (await ApiCallNode.handle(mockContext, validInputs)) as IBlokResponse;

		// Check the result structure
		expect(result.success).toBe(true);
		expect(result.data).toEqual(mockResult);
		expect(result.error).toBeNull();
	});

	it("should use ctx.response.data as the body if inputs.body is empty", async () => {
		mockContext.response.data = { fallback: "data" };
		const inputsWithoutBody = { ...validInputs, body: {} };

		const mockResult = { success: true, data: { fallback: "data" } };
		vi.mocked(runApiCall).mockResolvedValue(mockResult);

		const result = (await ApiCallNode.handle(mockContext, inputsWithoutBody)) as IBlokResponse;

		expect(result.success).toBe(true);
		expect(result.data).toEqual(mockResult);
		expect(result.error).toBeNull();
	});

	it("should return an error if the API call fails", async () => {
		const mockError = new Error("API request failed");

		vi.mocked(runApiCall).mockRejectedValue(mockError);

		const result = (await ApiCallNode.handle(mockContext, validInputs)) as IBlokResponse;

		expect(result.success).toBe(false);
		expect(result.error).toBeDefined();
		expect((result.error as GlobalError).message).toBe("API request failed");
		expect((result.error as GlobalError).context.code).toBe(500); // Runtime error = 500
	});

	it("should validate input with Zod and reject invalid URLs", async () => {
		const invalidInputs = {
			...validInputs,
			url: "not-a-valid-url",
		};

		const result = (await ApiCallNode.handle(mockContext, invalidInputs)) as IBlokResponse;

		expect(result.success).toBe(false);
		expect(result.error).toBeDefined();
		expect((result.error as GlobalError).context.code).toBe(400); // Validation error = 400
	});

	it("should use default values for optional fields", async () => {
		const minimalInputs = {
			url: "https://api.example.com",
		};

		const mockResult = { success: true };
		vi.mocked(runApiCall).mockResolvedValue(mockResult);

		const result = (await ApiCallNode.handle(mockContext, minimalInputs)) as IBlokResponse;

		expect(result.success).toBe(true);

		// Verify runApiCall was called with defaults
		expect(vi.mocked(runApiCall)).toHaveBeenCalledWith(
			"https://api.example.com",
			"GET", // default
			{}, // default headers
			mockContext.response.data, // default body from context
			"json", // default responseType
		);
	});
});
