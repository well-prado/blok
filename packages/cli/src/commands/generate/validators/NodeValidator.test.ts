/**
 * NodeValidator Tests
 *
 * Tests structural validation for AI-generated nodes
 */

import { describe, expect, it } from "vitest";
import { type NodeValidationContext, validateExports, validateFunctionFirstStructure } from "./NodeValidator.js";

describe("NodeValidator", () => {
	describe("validateFunctionFirstStructure", () => {
		it("should pass for valid function-first node", () => {
			const validCode = `
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "test-node",
  description: "A test node",

  input: z.object({
    userId: z.string(),
  }),

  output: z.string(),

  async execute(ctx, input) {
    return input.userId;
  },
});
      `;

			const context: NodeValidationContext = {
				filePath: "/tmp/test-node.ts",
				nodeStyle: "function",
				content: validCode,
			};

			const result = validateFunctionFirstStructure(context);

			expect(result.valid).toBe(true);
			expect(result.errors.length).toBe(0);
		});

		it("should fail for class-based node (old pattern)", () => {
			const classBasedCode = `
import { BlokService } from "@blokjs/runner";

export default class TestNode extends BlokService {
  async handle(ctx: any, input: any) {
    return { success: true };
  }
}
      `;

			const context: NodeValidationContext = {
				filePath: "/tmp/class-node.ts",
				nodeStyle: "function",
				content: classBasedCode,
			};

			const result = validateFunctionFirstStructure(context);

			expect(result.valid).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors.some((err) => err.includes("defineNode"))).toBe(true);
		});

		it("should fail for node missing execute function", () => {
			const incompleteCode = `
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "incomplete-node",
  description: "A node without implementation",

  input: z.string(),
  output: z.string(),
});
      `;

			const context: NodeValidationContext = {
				filePath: "/tmp/incomplete-node.ts",
				nodeStyle: "function",
				content: incompleteCode,
			};

			const result = validateFunctionFirstStructure(context);

			expect(result.valid).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors.some((err) => err.includes("execute"))).toBe(true);
		});

		it("should fail for node missing name property", () => {
			const invalidCode = `
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  description: "Missing name property",

  input: z.string(),
  output: z.string(),

  async execute(ctx, input) {
    return input;
  },
});
      `;

			const context: NodeValidationContext = {
				filePath: "/tmp/no-name-node.ts",
				nodeStyle: "function",
				content: invalidCode,
			};

			const result = validateFunctionFirstStructure(context);

			expect(result.valid).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors.some((err) => err.includes("name"))).toBe(true);
		});

		it("should fail for node missing description property", () => {
			const invalidCode = `
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "no-description",

  input: z.string(),
  output: z.string(),

  async execute(ctx, input) {
    return input;
  },
});
      `;

			const context: NodeValidationContext = {
				filePath: "/tmp/no-desc-node.ts",
				nodeStyle: "function",
				content: invalidCode,
			};

			const result = validateFunctionFirstStructure(context);

			expect(result.valid).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors.some((err) => err.includes("description"))).toBe(true);
		});

		it("should fail for node missing input schema", () => {
			const invalidCode = `
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "no-input",
  description: "Missing input schema",

  output: z.string(),

  async execute(ctx, input) {
    return "test";
  },
});
      `;

			const context: NodeValidationContext = {
				filePath: "/tmp/no-input-node.ts",
				nodeStyle: "function",
				content: invalidCode,
			};

			const result = validateFunctionFirstStructure(context);

			expect(result.valid).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors.some((err) => err.includes("input"))).toBe(true);
		});

		it("should fail for node missing output schema", () => {
			const invalidCode = `
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "no-output",
  description: "Missing output schema",

  input: z.string(),

  async execute(ctx, input) {
    return input;
  },
});
      `;

			const context: NodeValidationContext = {
				filePath: "/tmp/no-output-node.ts",
				nodeStyle: "function",
				content: invalidCode,
			};

			const result = validateFunctionFirstStructure(context);

			expect(result.valid).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors.some((err) => err.includes("output"))).toBe(true);
		});

		it("should pass for node with complex input/output schemas", () => {
			const validCode = `
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "complex-node",
  description: "Node with complex schemas",

  input: z.object({
    user: z.object({
      id: z.string().uuid(),
      email: z.string().email(),
      age: z.number().int().positive(),
    }),
    filters: z.array(z.string()).optional(),
    metadata: z.record(z.unknown()),
  }),

  output: z.union([
    z.object({
      success: z.literal(true),
      data: z.unknown(),
    }),
    z.object({
      success: z.literal(false),
      error: z.string(),
    }),
  ]),

  async execute(ctx, input) {
    return {
      success: true,
      data: input.user,
    };
  },
});
      `;

			const context: NodeValidationContext = {
				filePath: "/tmp/complex-node.ts",
				nodeStyle: "function",
				content: validCode,
			};

			const result = validateFunctionFirstStructure(context);

			expect(result.valid).toBe(true);
		});
	});

	describe("validateExports", () => {
		it("should pass for valid default export", () => {
			const validCode = `
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

export default defineNode({
  name: "test",
  description: "Test",
  input: z.string(),
  output: z.string(),
  async execute(ctx, input) {
    return input;
  },
});
      `;

			const context: NodeValidationContext = {
				filePath: "/tmp/export-test.ts",
				nodeStyle: "function",
				content: validCode,
			};

			const result = validateExports(context);

			expect(result.valid).toBe(true);
		});

		it("should fail for missing default export", () => {
			const invalidCode = `
import { defineNode } from "@blokjs/runner";
import { z } from "zod";

const myNode = defineNode({
  name: "test",
  description: "Test",
  input: z.string(),
  output: z.string(),
  async execute(ctx, input) {
    return input;
  },
});

// No default export
export { myNode };
      `;

			const context: NodeValidationContext = {
				filePath: "/tmp/no-export-node.ts",
				nodeStyle: "function",
				content: invalidCode,
			};

			const result = validateExports(context);

			expect(result.valid).toBe(false);
			expect(result.errors).toBeDefined();
			expect(result.errors.some((err) => err.includes("default export"))).toBe(true);
		});
	});
});
