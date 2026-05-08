import { defineNode } from "@blokjs/runner";
import { GlobalError } from "@blokjs/shared";
import { z } from "zod";

/**
 * Force-throw an error inside a step pipeline. Useful for:
 *
 * - `tryCatch.catch` default-arm handling
 * - `switch.default` short-circuit
 * - middleware short-circuits (auth-check 401, rate-limit 429, etc.)
 *
 * The thrown error is a `GlobalError` so the `code` and `body` fields
 * propagate through to the trigger's HTTP response handler — which
 * means an authored `code: 401` produces an actual 401 response, and
 * `body: {...}` produces a custom JSON body. Without this propagation,
 * RunnerSteps' default wrap loses the structured-error info and the
 * caller gets a generic 500.
 *
 * The error's `name` and `message` are also surfaced to the catching
 * `tryCatch.catch` arm via `$.error.message` / `$.error.name` (the
 * cause-chain unwrap in TryCatchNode peels the framework's per-step
 * prefix off so authors see their literal message).
 */
export default defineNode({
	name: "@blokjs/throw",
	description: "Force-throw an error with a custom message, status code, and JSON body.",
	input: z.object({
		message: z.string().min(1).describe("Error message. Surfaces as `$.error.message` in catch arms."),
		code: z
			.number()
			.int()
			.min(100)
			.max(599)
			.optional()
			.describe(
				"HTTP status code (100-599). Default 500. Used by HTTP triggers when this " +
					"error reaches the response handler. Common: 400 (bad request), 401 " +
					"(unauthorized), 403 (forbidden), 404 (not found), 409 (conflict), " +
					"422 (unprocessable), 429 (rate-limited).",
			),
		body: z
			.unknown()
			.optional()
			.describe(
				"Custom JSON body for the HTTP response. When set, the HTTP trigger " +
					"emits this verbatim instead of the default `{ error: <message> }` shape. " +
					"Useful for structured error envelopes (e.g. `{ error: 'unauthorized', " +
					"reason: 'token expired' }`).",
			),
		name: z.string().optional().describe("Error name. Surfaces as `$.error.name`. Default 'Error'."),
	}),
	output: z.never(),

	async execute(_ctx, input) {
		const err = new GlobalError(input.message);
		if (input.code !== undefined) err.setCode(input.code);
		if (input.body !== undefined) err.setJson(input.body as Record<string, unknown>);
		if (input.name !== undefined) err.setName(input.name);
		// Stash on the prototype-level field too so tryCatch's cause-chain
		// unwrap reads the right `.name` (Error class default-names to "Error"
		// regardless of GlobalError's internal context.name).
		if (input.name !== undefined) (err as Error).name = input.name;
		throw err;
	},
});
