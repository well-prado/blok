/**
 * NodeGenerator Tests
 *
 * Tests the semantic error guidance and feedback prompt generation (non-AI parts)
 */

import { describe, expect, it } from "vitest";
import NodeGenerator from "./NodeGenerator.js";

describe("NodeGenerator", () => {
	describe("getSemanticGuidance (via reflection)", () => {
		const generator = new NodeGenerator();
		const getGuidance = (error: string) =>
			(generator as unknown as { getSemanticGuidance: (e: string) => string | null }).getSemanticGuidance(error);

		it("should provide guidance for missing defineNode import", () => {
			const guidance = getGuidance("Missing defineNode import");
			expect(guidance).not.toBeNull();
			expect(guidance).toContain("defineNode");
			expect(guidance).toContain("@blok/runner");
		});

		it("should provide guidance for missing Zod import", () => {
			const guidance = getGuidance("Missing zod import");
			expect(guidance).not.toBeNull();
			expect(guidance).toContain("zod");
		});

		it("should provide guidance for cannot find defineNode", () => {
			const guidance = getGuidance("Cannot find name 'defineNode'");
			expect(guidance).not.toBeNull();
			expect(guidance).toContain("defineNode");
		});

		it("should provide guidance for Zod schema issues", () => {
			const guidance = getGuidance("Missing z.object() for input schema");
			expect(guidance).not.toBeNull();
			expect(guidance).toContain("z.object");
		});

		it("should provide guidance for missing async execute", () => {
			const guidance = getGuidance("Execute function must be async");
			expect(guidance).not.toBeNull();
			expect(guidance).toContain("async");
		});

		it("should provide guidance for missing execute function", () => {
			const guidance = getGuidance("Missing execute property");
			expect(guidance).not.toBeNull();
			expect(guidance).toContain("execute");
		});

		it("should provide guidance for missing default export", () => {
			const guidance = getGuidance("Missing export default");
			expect(guidance).not.toBeNull();
			expect(guidance).toContain("export default");
		});

		it("should provide guidance for type not assignable errors", () => {
			const guidance = getGuidance("Type 'string' is not assignable to type 'number'");
			expect(guidance).not.toBeNull();
			expect(guidance).toContain("output Zod schema");
		});

		it("should provide guidance for BlokResponse misuse", () => {
			const guidance = getGuidance("Do not use BlokResponse in function-first nodes");
			expect(guidance).not.toBeNull();
			expect(guidance).toContain("plain object");
		});

		it("should provide guidance for setSuccess misuse", () => {
			const guidance = getGuidance("response.setSuccess is not needed");
			expect(guidance).not.toBeNull();
			expect(guidance).toContain("plain object");
		});

		it("should provide guidance for module not found", () => {
			const guidance = getGuidance("Cannot find module '@blok/core'");
			expect(guidance).not.toBeNull();
			expect(guidance).toContain("import paths");
		});

		it("should provide guidance for context access patterns", () => {
			const guidance = getGuidance("Property 'request' does not exist on type 'Context'");
			expect(guidance).not.toBeNull();
			expect(guidance).toContain("ctx.request");
		});

		it("should return null for unknown error patterns", () => {
			const guidance = getGuidance("Some random error that doesn't match any pattern");
			expect(guidance).toBeNull();
		});
	});

	describe("createFeedbackPrompt (via reflection)", () => {
		const generator = new NodeGenerator();
		const createFeedback = (originalPrompt: string, previousCode: string, errors: string[]) =>
			(
				generator as unknown as { createFeedbackPrompt: (o: string, c: string, e: string[]) => string }
			).createFeedbackPrompt(originalPrompt, previousCode, errors);

		it("should include original prompt", () => {
			const result = createFeedback("Create a user fetcher node", "code", ["error"]);
			expect(result).toContain("Create a user fetcher node");
		});

		it("should include all errors with semantic guidance", () => {
			const errors = ["Missing defineNode import", "Missing zod import"];
			const result = createFeedback("test", "code", errors);

			expect(result).toContain("Missing defineNode import");
			expect(result).toContain("Missing zod import");
			// Should include semantic fix hints
			expect(result).toContain("Fix:");
		});

		it("should include previous code for context", () => {
			const code = "const x = 42;";
			const result = createFeedback("test", code, ["error"]);
			expect(result).toContain(code);
		});

		it("should include checklist of common requirements", () => {
			const result = createFeedback("test", "code", ["error"]);
			expect(result).toContain("defineNode");
			expect(result).toContain("zod");
			expect(result).toContain("export default");
			expect(result).toContain("z.object");
			expect(result).toContain("async");
		});
	});
});
