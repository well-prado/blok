/**
 * If-Else Node Tests - Updated for Function-First Implementation
 *
 * Tests migrated from class-based to function-first pattern.
 * All existing behavior is preserved.
 */

import type { Condition, INanoServiceResponse, JsonLikeObject, ParamsDictionary } from "@nanoservice-ts/runner";
import type { Context, NodeBase, ResponseContext } from "@nanoservice-ts/shared";
import { describe, expect, it, vi } from "vitest";
import IfElseNode from "../index";

describe("IfElse Node - Function-First", () => {
	const mockContext: Context = {
		response: {
			data: null,
			error: null,
			success: true,
		},
		request: {
			body: {} as ParamsDictionary,
			headers: {},
			params: {},
			query: {},
			method: "GET",
		},
		config: {
			"if-else": {},
		},
		id: "test-id",
		workflow_name: "test-workflow",
		workflow_path: "/test",
		error: {
			message: [],
		},
		logger: {
			log: vi.fn(),
			info: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
		} as unknown as Context["logger"],
		vars: {},
		env: {},
		eventLogger: null,
		_PRIVATE_: null,
	} as unknown as Context;

	const step: {
		name: string;
		run?: (ctx: Context, data: ParamsDictionary) => Promise<ResponseContext>;
	} = {
		name: "node1",
		run: async (ctx: Context, data: ParamsDictionary): Promise<ResponseContext> => ({} as ResponseContext),
	} as unknown as NodeBase;

	it("should execute the correct steps when if condition is true", async () => {
		const conditions: Condition[] = [
			{
				type: "if",
				condition: "ctx.request.method === 'GET'",
				steps: [
					(() => {
						step.name = "step1";
						return step as unknown as NodeBase;
					})(),
				],
			},
			{
				type: "else",
				steps: [step as unknown as NodeBase],
				condition: "",
			},
		];

		(mockContext.request as JsonLikeObject).method = "GET";
		const result = (await IfElseNode.handle(mockContext, conditions)) as INanoServiceResponse;
		const steps = result.data as NodeBase[];
		expect(steps[0].name).toEqual("step1");
	});

	it("should execute the else step when if condition is false", async () => {
		const conditions: Condition[] = [
			{
				type: "if",
				condition: "ctx.request.method === 'POST'",
				steps: [step as unknown as NodeBase],
			},
			{
				type: "else",
				steps: [
					(() => {
						step.name = "step2";
						return step as unknown as NodeBase;
					})(),
				],
				condition: "",
			},
		];

		const result = (await IfElseNode.handle(mockContext, conditions)) as INanoServiceResponse;
		const steps = result.data as NodeBase[];
		expect(steps[0].name).toEqual("step2");
	});

	it("should throw an error if the first condition is not 'if'", async () => {
		const conditions: Condition[] = [
			{
				type: "else",
				steps: [step as unknown as NodeBase],
				condition: "",
			},
		];

		const result = (await IfElseNode.handle(mockContext, conditions)) as INanoServiceResponse;
		expect(result.success).toBe(false);
		expect(result.error).toBeDefined();
	});

	it("should throw an error if the last condition is not 'else'", async () => {
		const conditions: Condition[] = [
			{
				type: "if",
				condition: "ctx.request.method === 'GET'",
				steps: [step as unknown as NodeBase],
			},
			{
				type: "if",
				condition: "ctx.request.method === 'POST'",
				steps: [step as unknown as NodeBase],
			},
		];

		const result = (await IfElseNode.handle(mockContext, conditions)) as INanoServiceResponse;
		expect(result.success).toBe(false);
		expect(result.error).toBeDefined();
	});

	it("should execute the first matching condition", async () => {
		const conditions: Condition[] = [
			{
				type: "if",
				condition: "ctx.request.method === 'POST'",
				steps: [step as unknown as NodeBase],
			},
			{
				type: "if",
				condition: "ctx.request.method === 'GET'",
				steps: [
					(() => {
						step.name = "step2";
						return step as unknown as NodeBase;
					})(),
				],
			},
			{
				type: "else",
				steps: [step as unknown as NodeBase],
				condition: "",
			},
		];

		(mockContext.request as JsonLikeObject).method = "GET";
		const result = (await IfElseNode.handle(mockContext, conditions)) as INanoServiceResponse;
		const steps = result.data as NodeBase[];
		expect(steps[0].name).toEqual("step2");
	});

	it("should execute the else condition if none match", async () => {
		const conditions: Condition[] = [
			{
				type: "if",
				condition: "ctx.request.method === 'POST'",
				steps: [step as unknown as NodeBase],
			},
			{
				type: "else",
				steps: [
					(() => {
						step.name = "step2";
						return step as unknown as NodeBase;
					})(),
				],
				condition: "",
			},
		];

		const result = (await IfElseNode.handle(mockContext, conditions)) as INanoServiceResponse;
		const steps = result.data as NodeBase[];
		expect(steps[0].name).toEqual("step2");
	});
});
