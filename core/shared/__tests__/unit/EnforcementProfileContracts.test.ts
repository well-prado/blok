import { describe, expect, it } from "vitest";
import {
	ENFORCEMENT_PROFILE_SEMANTICS,
	EnforcementProfileContractError,
	enforcementProfileSemantics,
	parseEnforcementProfile,
	parseEnforcementProfileContract,
	serializeEnforcementProfileContract,
} from "../../src/EnforcementProfileContracts";

describe("enforcement profile contracts", () => {
	it("defines the three profiles with machine-readable semantics", () => {
		expect(ENFORCEMENT_PROFILE_SEMANTICS).toEqual({
			advisory: { deviations: "record", transitions: "advisory", inRunOverride: "allowed" },
			guided: { deviations: "authorized-override", transitions: "enforced", inRunOverride: "allowed" },
			strict: { deviations: "reject", transitions: "enforced", inRunOverride: "forbidden" },
		});
		expect(enforcementProfileSemantics("strict")).toEqual(ENFORCEMENT_PROFILE_SEMANTICS.strict);
	});

	it("parses and serializes a versioned profile contract", () => {
		const contract = { version: "1", profile: "guided" } as const;
		expect(parseEnforcementProfile("advisory")).toBe("advisory");
		expect(parseEnforcementProfileContract({ ...contract, futureField: "ignored" })).toEqual(contract);
		expect(serializeEnforcementProfileContract(contract)).toBe(JSON.stringify(contract));
	});

	it("rejects unknown profiles and contract versions", () => {
		expect(() => parseEnforcementProfile("permissive")).toThrow(EnforcementProfileContractError);
		expect(() => parseEnforcementProfileContract({ version: "2", profile: "strict" })).toThrow(
			"enforcement profile contract.version",
		);
	});
});
