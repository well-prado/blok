/**
 * Example: Function-First Node
 *
 * This demonstrates the new defineNode API for creating type-safe,
 * Zod-validated nodes with minimal boilerplate.
 *
 * Compare this to a class-based node - this is 60%+ less code!
 */

import type { Context } from "@blok/shared";
import { z } from "zod";
import { defineNode } from "../../src/defineNode";

/**
 * Fetch User Node
 *
 * Fetches a user by ID and returns their profile information.
 * Demonstrates:
 * - Zod input validation (UUID format)
 * - Zod output validation (email format, required fields)
 * - Context usage (vars, logger)
 * - Type-safe inputs and outputs
 */
export default defineNode({
	name: "fetch-user",
	description: "Fetches user profile by ID from database",

	// Input schema with Zod validation
	input: z.object({
		userId: z.string().uuid("userId must be a valid UUID"),
		includeMetadata: z.boolean().optional().default(false),
	}),

	// Output schema with Zod validation
	output: z.object({
		user: z.object({
			id: z.string().uuid(),
			name: z.string().min(1),
			email: z.string().email(),
			createdAt: z.string().datetime(),
			metadata: z.record(z.unknown()).optional(),
		}),
	}),

	// Execution logic - input and output are type-safe!
	async execute(ctx: Context, input) {
		// TypeScript knows:
		// - input.userId is string (UUID validated)
		// - input.includeMetadata is boolean (defaults to false)

		ctx.logger.log(`Fetching user: ${input.userId}`);

		// Simulate database fetch
		const user = await fetchUserFromDatabase(input.userId, input.includeMetadata);

		// Store in context for downstream nodes
		if (ctx.vars) {
			ctx.vars["current-user"] = user;
		}

		// TypeScript knows this matches the output schema!
		// Zod will validate the structure automatically
		return { user };
	},
});

/**
 * Simulated database fetch
 * In production, this would call your actual database
 */
async function fetchUserFromDatabase(
	userId: string,
	includeMetadata: boolean,
): Promise<{
	id: string;
	name: string;
	email: string;
	createdAt: string;
	metadata?: Record<string, unknown>;
}> {
	// Simulate async database call
	await new Promise((resolve) => setTimeout(resolve, 10));

	return {
		id: userId,
		name: "John Doe",
		email: "john@example.com",
		createdAt: new Date().toISOString(),
		...(includeMetadata && {
			metadata: {
				lastLogin: new Date().toISOString(),
				loginCount: 42,
			},
		}),
	};
}
