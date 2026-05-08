import { defineNode } from "@blokjs/runner";
import Ajv, { type ErrorObject } from "ajv";
import { z } from "zod";

/**
 * Validate `data` against a JSON Schema. Throws on validation failure
 * with a clear message listing every error path.
 *
 * Use as a first step in workflows that take user input and want a
 * declarative validation surface (the alternative — Zod inside a custom
 * defineNode — is fine too, this just lets you keep schemas in JSON).
 */
const ajv = new Ajv({ allErrors: true, strict: false });

function formatErrors(errors: ErrorObject[]): string {
	return errors
		.map((e) => {
			const path = e.instancePath || e.schemaPath;
			return `${path} ${e.message ?? "invalid"}`;
		})
		.join("; ");
}

export default defineNode({
	name: "@blokjs/json-schema",
	description: "Validate `data` against a JSON Schema. Throws on validation failure.",
	input: z.object({
		schema: z.unknown(),
		data: z.unknown(),
	}),
	output: z.object({
		valid: z.boolean(),
	}),

	async execute(_ctx, input) {
		const validate = ajv.compile(input.schema as object);
		const ok = validate(input.data);
		if (!ok) {
			throw new Error(`json-schema validation failed: ${formatErrors(validate.errors ?? [])}`);
		}
		return { valid: true };
	},
});
