/**
 * Authorization — issue #1013.
 *
 * Inertia has no authorization protocol: the documented convention is to ship
 * the decisions to the client as props (`can: { edit: true }`) and to enforce
 * them on the server. These two helpers are exactly that convention, typed.
 *
 * https://inertiajs.com/docs/v3/security/authorization
 */

import { defineNode } from "@blokjs/core";
import { GlobalError } from "@blokjs/shared";
import { z } from "zod";

/** A decision, or something that computes one lazily. */
export type AbilityRule = boolean | (() => boolean);

function decide(rule: AbilityRule): boolean {
	return typeof rule === "function" ? rule() : rule;
}

/**
 * Turn a rule map into the plain `{ ability: boolean }` object Inertia expects
 * as a `can` prop — page-level, or per item in a list.
 *
 * ```ts
 * props: {
 *   can: can({ create: user.isAdmin }),
 *   posts: posts.map((post) => ({ ...post, can: can({ edit: () => post.authorId === user.id }) })),
 * }
 * ```
 *
 * Function rules are called immediately (this is not a lazy prop — deferring a
 * prop is the `page` step's job, #1008); they exist so a rule can be written
 * inline without evaluating an expensive check twice.
 */
export function can<K extends string>(rules: Record<K, AbilityRule>): Record<K, boolean> {
	const out = {} as Record<K, boolean>;
	for (const key of Object.keys(rules) as K[]) out[key] = decide(rules[key]);
	return out;
}

/**
 * Enforce one ability, or throw.
 *
 * The throw is a `GlobalError` carrying `403` and `{ error: "forbidden",
 * ability }`, which is what the HTTP trigger writes to the wire — the same
 * shape `@blokjs/throw` produces, so no new transport behavior is involved.
 *
 * Rendering that 403 as an Inertia ERROR PAGE (rather than a JSON body) is
 * #1014's job; until it lands, an Inertia visit receives the JSON body.
 */
export function authorize(ability: string, allowed: AbilityRule): void {
	if (decide(allowed)) return;
	const err = new GlobalError(`Forbidden: ${ability}`);
	err.setCode(403);
	err.setJson({ error: "forbidden", ability });
	err.setName("Forbidden");
	// `Error.name` too — the tryCatch cause-chain unwrap reads the class field.
	err.name = "Forbidden";
	throw err;
}

/** {@link authorize} as a workflow step. */
export const authorizeNode = defineNode({
	name: "@blokjs/inertia.authorize",
	description: "Throw a 403 ({ error: 'forbidden', ability }) unless the ability is allowed.",
	input: z.object({
		ability: z.string().min(1).describe("The ability being checked, e.g. 'edit'."),
		allowed: z.boolean().describe("The decision. false throws the 403."),
	}),
	output: z.object({ ability: z.string(), allowed: z.literal(true) }),

	async execute(_ctx, input) {
		authorize(input.ability, input.allowed);
		return { ability: input.ability, allowed: true as const };
	},
});
