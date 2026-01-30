import type { ZodError, z } from "zod";

import type { Context } from "@blok/shared";
import { GlobalError, NodeBase } from "@blok/shared";
import type { Schema } from "jsonschema";
import BlokService from "./Blok";
import type { IBlokResponse } from "./BlokResponse";
import BlokResponse from "./BlokResponse";
import type Condition from "./types/Condition";
import type JsonLikeObject from "./types/JsonLikeObject";

/**
 * Function-first node definition with Zod schema validation
 *
 * @example
 * ```typescript
 * const MyNode = defineNode({
 *   name: "my-node",
 *   description: "Does something awesome",
 *
 *   input: z.object({
 *     userId: z.string().uuid(),
 *   }),
 *
 *   output: z.object({
 *     user: z.object({
 *       id: z.string(),
 *       name: z.string(),
 *     }),
 *   }),
 *
 *   async execute(ctx, input) {
 *     // Type-safe input and output!
 *     const user = await fetchUser(input.userId);
 *     return { user };
 *   },
 * });
 * ```
 */
export interface FnNodeDefinition<
	TInput extends z.ZodTypeAny = z.ZodTypeAny,
	TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> {
	/** Node name (used for identification in workflows) */
	name: string;

	/** Human-readable description of what this node does */
	description: string;

	/** Zod schema for input validation */
	input: TInput;

	/** Zod schema for output validation */
	output: TOutput;

	/** Response content type (e.g. "text/html", "application/pdf"). Defaults to "application/json" */
	contentType?: string;

	/** Whether this is a flow control node (e.g. if-else) that returns sub-steps to execute */
	flow?: boolean;

	/**
	 * Node execution logic
	 * @param ctx - Workflow context
	 * @param input - Type-safe input (validated against input schema)
	 * @returns Type-safe output (will be validated against output schema)
	 */
	execute: (ctx: Context, input: z.infer<TInput>) => Promise<z.infer<TOutput>> | z.infer<TOutput>;
}

/**
 * FunctionNode wrapper that bridges function-first nodes to existing BlokService infrastructure
 *
 * This class wraps a function-first node definition and makes it compatible with the
 * existing BlokService.run() execution model. It handles:
 * - Zod input validation
 * - Zod output validation
 * - Error mapping (ZodError → GlobalError)
 * - Response wrapping (BlokResponse)
 */
export class FunctionNode<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny> extends BlokService<
	z.infer<TInput>
> {
	private definition: FnNodeDefinition<TInput, TOutput>;

	constructor(definition: FnNodeDefinition<TInput, TOutput>) {
		super();
		this.definition = definition;
		this.name = definition.name;

		// Set content type if specified (e.g. "text/html", "application/pdf")
		if (definition.contentType) {
			this.contentType = definition.contentType;
		}

		// Set flow flag for control flow nodes (e.g. if-else) that return sub-steps
		if (definition.flow) {
			this.flow = true;
		}

		// Convert Zod schemas to JSON Schema for backward compatibility
		// This allows existing tools that expect JSON Schema to continue working
		this.inputSchema = this.zodToJsonSchema(definition.input);
		this.outputSchema = this.zodToJsonSchema(definition.output);
	}

	/**
	 * Implementation of the abstract handle() method required by BlokService
	 *
	 * This method:
	 * 1. Validates input with Zod
	 * 2. Executes the user's execute() function
	 * 3. Validates output with Zod
	 * 4. Wraps result in BlokResponse
	 * 5. Maps any errors to GlobalError
	 */
	async handle(
		ctx: Context,
		inputs: z.infer<TInput> | JsonLikeObject | Condition[],
	): Promise<IBlokResponse | BlokService<z.infer<TInput>>[]> {
		const response: BlokResponse = new BlokResponse();

		try {
			// Step 1: Validate input with Zod
			const validatedInput = this.definition.input.parse(inputs);

			// Step 2: Execute user's function
			const result = await this.definition.execute(ctx, validatedInput);

			// Step 3: If execute() returns an array of NodeBase instances (flow nodes
			// like if-else), return them directly. The runner's processFlow() expects
			// handle() to return BlokService[] for flow nodes, not a wrapped response.
			if (Array.isArray(result) && result.length > 0 && result[0] instanceof NodeBase) {
				return result as BlokService<z.infer<TInput>>[];
			}

			// Step 4: Validate output with Zod
			const validatedOutput = this.definition.output.parse(result);

			// Step 5: Success!
			response.setSuccess(validatedOutput as JsonLikeObject);
		} catch (error) {
			// Step 6: Map errors to GlobalError
			const globalError = this.mapErrorToGlobalError(error);
			response.setError(globalError);
		}

		return response;
	}

	/**
	 * Maps any error to GlobalError, with special handling for ZodError
	 *
	 * ZodError produces detailed validation errors that are transformed into
	 * a user-friendly error message with all validation issues listed.
	 *
	 * @param error - Any error thrown during execution
	 * @returns GlobalError instance
	 */
	private mapErrorToGlobalError(error: unknown): GlobalError {
		// Duck typing check for ZodError - more reliable than instanceof across module boundaries
		// ZodError has: { name: "ZodError", issues: [...] }
		if (
			error &&
			typeof error === "object" &&
			"issues" in error &&
			Array.isArray((error as { issues: unknown }).issues) &&
			"name" in error &&
			(error as { name: unknown }).name === "ZodError"
		) {
			return this.zodErrorToGlobalError(error as ZodError);
		}

		if (error instanceof Error) {
			const globalError = new GlobalError(error.message);
			globalError.setStack(error.stack);
			globalError.setName(this.name);
			globalError.setCode(500);
			return globalError;
		}

		// Unknown error type
		const globalError = new GlobalError(String(error));
		globalError.setName(this.name);
		globalError.setCode(500);
		return globalError;
	}

	/**
	 * Converts ZodError to GlobalError with detailed validation messages
	 *
	 * Example output:
	 * "Validation failed: userId (expected string, received undefined),
	 *  email (invalid email format)"
	 *
	 * @param zodError - Zod validation error
	 * @returns GlobalError with formatted validation messages
	 */
	private zodErrorToGlobalError(zodError: ZodError): GlobalError {
		const errorMessages = zodError.errors.map((err) => {
			const path = err.path.join(".");
			return `${path} (${err.message})`;
		});

		const message = `Validation failed: ${errorMessages.join(", ")}`;
		const globalError = new GlobalError(message);
		globalError.setCode(400); // Bad Request
		globalError.setName(this.name);
		globalError.setJson({
			validation_errors: zodError.errors.map((err) => ({
				path: err.path,
				message: err.message,
				code: err.code,
			})),
		});

		return globalError;
	}

	/**
	 * Converts Zod schema to JSON Schema for backward compatibility
	 *
	 * This is a simplified conversion that covers basic types.
	 * For production use, consider using zod-to-json-schema library.
	 *
	 * @param zodSchema - Zod schema to convert
	 * @returns JSON Schema representation
	 */
	private zodToJsonSchema(_zodSchema: z.ZodTypeAny): Schema {
		// Return a permissive schema — the actual validation happens via Zod in handle().
		// Using {} (no type constraint) instead of { type: "object" } so that nodes
		// accepting arrays (e.g. if-else conditions) also pass the JSON Schema pre-check.
		return {};
	}
}

/**
 * Define a function-first node with Zod schema validation
 *
 * This is the main API for creating modern, type-safe nodes in Blok.
 *
 * Benefits over class-based nodes:
 * - 60%+ less boilerplate code
 * - Type-safe inputs and outputs via Zod
 * - Automatic validation
 * - Better AI generation success rates
 * - Easier to test and maintain
 *
 * @example
 * ```typescript
 * import { defineNode } from "@blok/runner";
 * import { z } from "zod";
 *
 * export default defineNode({
 *   name: "fetch-user",
 *   description: "Fetches user by ID from database",
 *
 *   input: z.object({
 *     userId: z.string().uuid(),
 *   }),
 *
 *   output: z.object({
 *     user: z.object({
 *       id: z.string(),
 *       name: z.string(),
 *       email: z.string().email(),
 *     }),
 *   }),
 *
 *   async execute(ctx, input) {
 *     const user = await db.users.findById(input.userId);
 *     return { user };
 *   },
 * });
 * ```
 *
 * @param definition - Node definition with Zod schemas
 * @returns FunctionNode instance compatible with existing runner
 */
export function defineNode<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
	definition: FnNodeDefinition<TInput, TOutput>,
): FunctionNode<TInput, TOutput> {
	return new FunctionNode(definition);
}
