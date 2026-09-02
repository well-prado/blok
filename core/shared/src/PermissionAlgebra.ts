import { z } from "zod";
import { CAPABILITY_EFFECTS, type CapabilityEffect } from "./CapabilityManifest";

/** The scalar values accepted in a capability authority's constraint fragments. */
export const CapabilityFragmentValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

const capabilityIdentifier = z
	.string()
	.regex(/^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/, "must be a valid capability or secret reference name");

/**
 * A normalized authority envelope. An empty list means that the envelope does
 * not grant that category; an omitted policy envelope means that policy did
 * not add a further restriction.
 */
export interface CapabilityAuthority {
	readonly effects: readonly CapabilityEffect[];
	readonly capabilities: readonly string[];
	readonly secrets: readonly string[];
	readonly fragments: Readonly<Record<string, string | number | boolean>>;
}

export const CapabilityAuthoritySchema = z
	.object({
		effects: z.array(z.enum(CAPABILITY_EFFECTS)),
		capabilities: z.array(capabilityIdentifier),
		secrets: z.array(capabilityIdentifier),
		fragments: z.record(CapabilityFragmentValueSchema),
	})
	.strict();

export class CapabilityAuthorityError extends Error {
	readonly code = "CAPABILITY_AUTHORITY_INVALID";
	readonly errors: readonly string[];

	constructor(errors: readonly string[]) {
		super(`Invalid capability authority: ${errors.join("; ")}`);
		this.name = "CapabilityAuthorityError";
		this.errors = [...errors];
	}
}

function sortedUnique(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

function stableFragments(
	fragments: Readonly<Record<string, string | number | boolean>>,
): Readonly<Record<string, string | number | boolean>> {
	const result: Record<string, string | number | boolean> = {};
	for (const key of Object.keys(fragments).sort()) result[key] = fragments[key];
	return Object.freeze(result);
}

function normalize(value: z.infer<typeof CapabilityAuthoritySchema>): CapabilityAuthority {
	return Object.freeze({
		effects: Object.freeze(sortedUnique(value.effects) as CapabilityEffect[]),
		capabilities: Object.freeze(sortedUnique(value.capabilities)),
		secrets: Object.freeze(sortedUnique(value.secrets)),
		fragments: stableFragments(value.fragments),
	});
}

function formatIssue(path: readonly (string | number)[], message: string): string {
	return `${path.length > 0 ? `authority.${path.join(".")}` : "authority"} ${message}`;
}

/** Parse, validate, canonicalize, and freeze an authority envelope. */
export function parseCapabilityAuthority(value: unknown): CapabilityAuthority {
	const parsed = CapabilityAuthoritySchema.safeParse(value);
	if (!parsed.success) {
		const errors = parsed.error.issues
			.map((issue) => formatIssue(issue.path, issue.message))
			.sort((left, right) => left.localeCompare(right));
		throw new CapabilityAuthorityError(errors);
	}
	return normalize(parsed.data);
}

function commonValues<T extends string>(left: readonly T[], right: readonly T[]): T[] {
	const rightSet = new Set(right);
	return [...new Set(left)].filter((value): value is T => rightSet.has(value)).sort();
}

/**
 * Compute the monotonic permission intersection. The operation is
 * commutative, associative, and returns a canonical frozen value, making it
 * safe to persist in requests and traces.
 */
export function intersectCapabilityAuthorities(...authorities: readonly CapabilityAuthority[]): CapabilityAuthority {
	if (authorities.length === 0) {
		return parseCapabilityAuthority({ effects: [], capabilities: [], secrets: [], fragments: {} });
	}
	let result = parseCapabilityAuthority(authorities[0]);
	for (const authority of authorities.slice(1)) {
		const next = parseCapabilityAuthority(authority);
		const fragments: Record<string, string | number | boolean> = {};
		for (const key of Object.keys(result.fragments).sort()) {
			if (
				Object.prototype.hasOwnProperty.call(next.fragments, key) &&
				Object.is(result.fragments[key], next.fragments[key])
			) {
				fragments[key] = result.fragments[key];
			}
		}
		result = Object.freeze({
			effects: Object.freeze(commonValues(result.effects, next.effects) as CapabilityEffect[]),
			capabilities: Object.freeze(commonValues(result.capabilities, next.capabilities)),
			secrets: Object.freeze(commonValues(result.secrets, next.secrets)),
			fragments: stableFragments(fragments),
		});
	}
	return result;
}

function isSubset<T extends string>(child: readonly T[], parent: readonly T[]): boolean {
	const parentSet = new Set(parent);
	return child.every((value) => parentSet.has(value));
}

/** Return whether a child authority is no broader than its parent. */
export function isCapabilityAuthoritySubset(child: CapabilityAuthority, parent: CapabilityAuthority): boolean {
	if (!isSubset(child.effects, parent.effects)) return false;
	if (!isSubset(child.capabilities, parent.capabilities)) return false;
	if (!isSubset(child.secrets, parent.secrets)) return false;
	return Object.entries(child.fragments).every(([key, value]) => Object.is(parent.fragments[key], value));
}

/**
 * Validate child delegation before dispatch. Errors use stable category and
 * sorted-value ordering so callers and conformance tests can inspect them.
 */
export function assertCapabilityAuthoritySubset(
	child: CapabilityAuthority,
	parent: CapabilityAuthority,
	path = "child authority",
): void {
	const errors: string[] = [];
	const check = (category: string, childValues: readonly string[], parentValues: readonly string[]) => {
		const parentSet = new Set(parentValues);
		const widened = childValues.filter((value) => !parentSet.has(value)).sort();
		if (widened.length > 0) errors.push(`${path}.${category} contains unauthorized value(s): ${widened.join(", ")}`);
	};
	check("effects", child.effects, parent.effects);
	check("capabilities", child.capabilities, parent.capabilities);
	check("secrets", child.secrets, parent.secrets);
	const missingFragments = Object.entries(child.fragments)
		.filter(([key, value]) => !Object.is(parent.fragments[key], value))
		.sort(([left], [right]) => left.localeCompare(right));
	for (const [key, value] of missingFragments) {
		errors.push(`${path}.fragments.${key} is not permitted: ${JSON.stringify(value)}`);
	}
	if (errors.length > 0) throw new CapabilityAuthorityError(errors.sort((left, right) => left.localeCompare(right)));
}
