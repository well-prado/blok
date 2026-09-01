import { z } from "zod";

/** Version of the language-neutral enforcement profile contract. */
export const ENFORCEMENT_PROFILE_CONTRACT_VERSION = "1" as const;

export const ENFORCEMENT_PROFILES = ["advisory", "guided", "strict"] as const;
export type EnforcementProfile = (typeof ENFORCEMENT_PROFILES)[number];

export interface EnforcementProfileSemantics {
	readonly deviations: "record" | "authorized-override" | "reject";
	readonly transitions: "advisory" | "enforced";
	readonly inRunOverride: "allowed" | "forbidden";
}

/** Machine-readable semantics; keep this table in sync with ADR 0002. */
export const ENFORCEMENT_PROFILE_SEMANTICS: Readonly<Record<EnforcementProfile, EnforcementProfileSemantics>> = {
	advisory: {
		deviations: "record",
		transitions: "advisory",
		inRunOverride: "allowed",
	},
	guided: {
		deviations: "authorized-override",
		transitions: "enforced",
		inRunOverride: "allowed",
	},
	strict: {
		deviations: "reject",
		transitions: "enforced",
		inRunOverride: "forbidden",
	},
};

export const EnforcementProfileSchema = z.enum(ENFORCEMENT_PROFILES);

export interface EnforcementProfileContract {
	readonly version: typeof ENFORCEMENT_PROFILE_CONTRACT_VERSION;
	readonly profile: EnforcementProfile;
}

export const EnforcementProfileContractSchema = z.object({
	version: z.literal(ENFORCEMENT_PROFILE_CONTRACT_VERSION),
	profile: EnforcementProfileSchema,
});

export class EnforcementProfileContractError extends Error {
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(`Invalid enforcement profile contract: ${issues.join("; ")}`);
		this.name = "EnforcementProfileContractError";
		this.issues = [...issues];
	}
}

function parseSchema<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
	const result = schema.safeParse(value);
	if (!result.success) {
		throw new EnforcementProfileContractError(
			result.error.issues.map(
				(issue) => `${label}${issue.path.length > 0 ? `.${issue.path.join(".")}` : ""} ${issue.message}`,
			),
		);
	}
	return result.data;
}

export function parseEnforcementProfile(value: unknown): EnforcementProfile {
	return parseSchema(EnforcementProfileSchema, value, "enforcement profile");
}

export function parseEnforcementProfileContract(value: unknown): EnforcementProfileContract {
	return parseSchema(EnforcementProfileContractSchema, value, "enforcement profile contract");
}

/** Return the immutable, machine-readable behavior for one profile. */
export function enforcementProfileSemantics(value: unknown): EnforcementProfileSemantics {
	return ENFORCEMENT_PROFILE_SEMANTICS[parseEnforcementProfile(value)];
}

export function serializeEnforcementProfileContract(value: unknown): string {
	return JSON.stringify(parseEnforcementProfileContract(value));
}
