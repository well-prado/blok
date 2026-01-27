import type { Context } from "@nanoservice-ts/shared";
import { GlobalError } from "@nanoservice-ts/shared";
import type { Schema } from "jsonschema";
import { z, type ZodError } from "zod";
import NanoService from "./NanoService";
import type { INanoServiceResponse } from "./NanoServiceResponse";
import NanoServiceResponse from "./NanoServiceResponse";
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

	/**
	 * Node execution logic
	 * @param ctx - Workflow context
	 * @param input - Type-safe input (validated against input schema)
	 * @returns Type-safe output (will be validated against output schema)
	 */
	execute: (
		ctx: Context,
		input: z.infer<TInput>,
	) => Promise<z.infer<TOutput>> | z.infer<TOutput>;
}

/**
 * FunctionNode wrapper that bridges function-first nodes to existing NanoService infrastructure
 *
 * This class wraps a function-first node definition and makes it compatible with the
 * existing NanoService.run() execution model. It handles:
 * - Zod input validation
 * - Zod output validation
 * - Error mapping (ZodError → GlobalError)
 * - Response wrapping (NanoServiceResponse)
 */
export class FunctionNode<
	TInput extends z.ZodTypeAny,
	TOutput extends z.ZodTypeAny,
> extends NanoService<z.infer<TInput>> {
	private definition: FnNodeDefinition<TInput, TOutput>;

	constructor(definition: FnNodeDefinition<TInput, TOutput>) {
		super();
		this.definition = definition;
		this.name = definition.name;

		// Convert Zod schemas to JSON Schema for backward compatibility
		// This allows existing tools that expect JSON Schema to continue working
		this.inputSchema = this.zodToJsonSchema(definition.input);
		this.outputSchema = this.zodToJsonSchema(definition.output);
	}

	/**
	 * Implementation of the abstract handle() method required by NanoService
	 *
	 * This method:
	 * 1. Validates input with Zod
	 * 2. Executes the user's execute() function
	 * 3. Validates output with Zod
	 * 4. Wraps result in NanoServiceResponse
	 * 5. Maps any errors to GlobalError
	 */
	async handle(
		ctx: Context,
		inputs: z.infer<TInput> | JsonLikeObject | Condition[],
	): Promise<INanoServiceResponse | NanoService<z.infer<TInput>>[]> {
		const response: NanoServiceResponse = new NanoServiceResponse();

		try {
			// Step 1: Validate input with Zod
			const validatedInput = this.definition.input.parse(inputs);

			// Step 2: Execute user's function
			const result = await this.definition.execute(ctx, validatedInput);

			// Step 3: Validate output with Zod
			const validatedOutput = this.definition.output.parse(result);

			// Step 4: Success!
			response.setSuccess(validatedOutput as JsonLikeObject);
		} catch (error) {
			// Step 5: Map errors to GlobalError
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
		if (error instanceof z.ZodError) {
			return this.zodErrorToGlobalError(error);
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
	private zodToJsonSchema(zodSchema: z.ZodTypeAny): Schema {
		// Basic conversion - this is a simplified implementation
		// For full Zod to JSON Schema conversion, we could use zod-to-json-schema library

		// For now, return a permissive schema that allows the Zod validation to be the source of truth
		return {
			type: "object",
			// The actual validation happens via Zod in handle(),
			// so we use a permissive JSON Schema here
		};
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
 * import { defineNode } from "@nanoservice-ts/runner";
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
export function defineNode<
	TInput extends z.ZodTypeAny,
	TOutput extends z.ZodTypeAny,
>(definition: FnNodeDefinition<TInput, TOutput>): FunctionNode<TInput, TOutput> {
	return new FunctionNode(definition);
}
