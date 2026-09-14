import { defineNode } from "@blokjs/runner";
import Ajv, { type ErrorObject } from "ajv";
import { z } from "zod";

/**
 * `@blokjs/validate` — validate a payload and RETURN the outcome (#1011).
 *
 * The difference from `@blokjs/json-schema` is the whole point: that node
 * THROWS, which is right for a machine API and wrong for a form. Inertia's
 * validation flow needs the failure as data — `redirectBack(req, { errors })`
 * on a normal visit, a `422 { errors }` on a Precognition dry run — so this
 * node never throws on invalid input. It returns `{ ok, data, errors }`.
 *
 * `errors` is keyed the way Inertia's client expects and Laravel emits: DOT
 * PATHS. A nested field is `user.name`, an array element is `items.0.name`.
 * Each key holds the FIRST message by default, or every message when
 * `withAllErrors` is set — the same choice `normalizeErrors()` makes on the
 * `@blokjs/inertia` side, made once here so authors never hand-map a
 * `ZodError`.
 *
 * `schema` takes either a Zod schema VALUE (the TS authoring path — step
 * inputs are not deep-cloned through the mapper, so the instance arrives
 * intact) or a plain JSON Schema object (the JSON-workflow path, validated
 * with the `ajv` this package already depends on). Both produce identical
 * error keys.
 *
 * @example
 * const checked = step("check", validateNode, { schema: OrderSchema, data: req.body });
 * branch("bad", eq(checked.ok, false), { then: () => { ... } });
 */

/** Zod issue path segments (`["items", 0, "name"]`) → `items.0.name`. */
function dotPath(path: readonly (string | number)[]): string {
	// A root-level refinement carries an EMPTY path. `_` is the bucket for it:
	// every real field key has at least one segment, so it cannot collide.
	return path.length === 0 ? "_" : path.map(String).join(".");
}

/** Collapse a `path -> messages` map to the wire shape the adapter is configured for. */
function collapse(all: Record<string, string[]>, withAllErrors: boolean): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = {};
	for (const [key, messages] of Object.entries(all)) {
		out[key] = withAllErrors ? messages : (messages[0] as string);
	}
	return out;
}

/**
 * A `ZodError`'s issues as dot-path keys. Exported because the precognition
 * tests and any author hand-rolling a validation node need the SAME mapping —
 * two copies of this would be two subtly different error shapes.
 */
export function zodErrors(error: z.ZodError, withAllErrors = false): Record<string, string | string[]> {
	const all: Record<string, string[]> = {};
	for (const issue of error.issues) {
		const key = dotPath(issue.path);
		all[key] ??= [];
		all[key].push(issue.message);
	}
	return collapse(all, withAllErrors);
}

/** Ajv errors as the same dot-path keys (`/items/0/name` → `items.0.name`). */
export function jsonSchemaErrors(
	errors: readonly ErrorObject[],
	withAllErrors = false,
): Record<string, string | string[]> {
	const all: Record<string, string[]> = {};
	for (const error of errors) {
		const segments = error.instancePath.split("/").filter((segment) => segment.length > 0);
		// `required` reports on the PARENT object and names the absent key in
		// `params.missingProperty` — without appending it every missing field on
		// one object would collapse into a single `""`/parent key.
		const missing = (error.params as { missingProperty?: string } | undefined)?.missingProperty;
		if (typeof missing === "string") segments.push(missing);
		const key = dotPath(segments);
		all[key] ??= [];
		all[key].push(error.message ?? "invalid");
	}
	return collapse(all, withAllErrors);
}

/** `ajv` is shared with `@blokjs/json-schema`'s instance shape: all errors, non-strict. */
const ajv = new Ajv({ allErrors: true, strict: false });

/** True for a Zod schema value (v3 tags every schema with `_def` + `safeParse`). */
function isZodSchema(value: unknown): value is z.ZodTypeAny {
	return (
		typeof value === "object" &&
		value !== null &&
		"_def" in value &&
		typeof (value as { safeParse?: unknown }).safeParse === "function"
	);
}

export default defineNode({
	name: "@blokjs/validate",
	description:
		"Validate `data` against a Zod or JSON Schema and RETURN { ok, data, errors } instead of throwing. Errors are keyed by dot path (user.name, items.0.name) for Inertia's errors prop.",
	input: z.object({
		schema: z.unknown().describe("A Zod schema value (TS authoring) or a plain JSON Schema object (JSON workflows)."),
		data: z.unknown().describe("The payload to validate — typically the request body."),
		withAllErrors: z
			.boolean()
			.optional()
			.describe("Emit EVERY message per field (string[]) instead of only the first (string). Default false."),
	}),
	output: z.object({
		ok: z.boolean().describe("True when `data` satisfied the schema."),
		data: z.unknown().describe("The parsed value on success (Zod coercions applied); undefined on failure."),
		errors: z
			.record(z.unknown())
			.describe("Dot-path keyed messages, {} when valid. `string` per key, or `string[]` under withAllErrors."),
	}),

	async execute(_ctx, input) {
		const withAllErrors = input.withAllErrors === true;

		if (isZodSchema(input.schema)) {
			const parsed = input.schema.safeParse(input.data);
			return parsed.success
				? { ok: true, data: parsed.data, errors: {} }
				: { ok: false, data: undefined, errors: zodErrors(parsed.error, withAllErrors) };
		}

		if (typeof input.schema !== "object" || input.schema === null) {
			throw new Error(
				`@blokjs/validate: \`schema\` must be a Zod schema value or a JSON Schema object — got ${
					input.schema === null ? "null" : typeof input.schema
				}.`,
			);
		}

		const validate = ajv.compile(input.schema as object);
		return validate(input.data)
			? { ok: true, data: input.data, errors: {} }
			: { ok: false, data: undefined, errors: jsonSchemaErrors(validate.errors ?? [], withAllErrors) };
	},
});
