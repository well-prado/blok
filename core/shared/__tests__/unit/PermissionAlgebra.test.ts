import { describe, expect, it } from "vitest";
import {
	CapabilityAuthorityError,
	assertCapabilityAuthoritySubset,
	intersectCapabilityAuthorities,
	isCapabilityAuthoritySubset,
	parseCapabilityAuthority,
} from "../../src/PermissionAlgebra";

const parent = {
	effects: ["write", "read", "network"] as const,
	capabilities: ["workspace.write", "workspace.read", "network.http"] as const,
	secrets: ["github.token"] as const,
	fragments: { workspace: "repo-a", maxFiles: 10 },
};

describe("permission algebra", () => {
	it("normalizes and intersects every authority dimension deterministically", () => {
		const left = parseCapabilityAuthority(parent);
		const right = parseCapabilityAuthority({
			effects: ["read", "network"],
			capabilities: ["network.http", "workspace.read"],
			secrets: ["github.token"],
			fragments: { workspace: "repo-a", maxFiles: 10 },
		});

		expect(intersectCapabilityAuthorities(left, right)).toEqual({
			effects: ["network", "read"],
			capabilities: ["network.http", "workspace.read"],
			secrets: ["github.token"],
			fragments: { maxFiles: 10, workspace: "repo-a" },
		});
		expect(intersectCapabilityAuthorities(left, right)).toEqual(intersectCapabilityAuthorities(right, left));
	});

	it("rejects a widened child with stable, sorted validation errors", () => {
		const child = parseCapabilityAuthority({
			effects: ["destructive", "read"],
			capabilities: ["workspace.read", "shell.exec"],
			secrets: ["aws.key"],
			fragments: { workspace: "repo-b", maxFiles: 10 },
		});

		expect(() => assertCapabilityAuthoritySubset(child, parseCapabilityAuthority(parent))).toThrow(
			new CapabilityAuthorityError([
				"child authority.capabilities contains unauthorized value(s): shell.exec",
				"child authority.effects contains unauthorized value(s): destructive",
				'child authority.fragments.workspace is not permitted: "repo-b"',
				"child authority.secrets contains unauthorized value(s): aws.key",
			]),
		);
		expect(isCapabilityAuthoritySubset(child, parseCapabilityAuthority(parent))).toBe(false);
	});

	it("reports malformed values through the same deterministic error type", () => {
		expect(() =>
			parseCapabilityAuthority({ effects: ["unknown"], capabilities: [], secrets: [], fragments: {} }),
		).toThrow(/authority.effects.0 Invalid enum value/);
		expect(() =>
			parseCapabilityAuthority({ effects: [], capabilities: [], secrets: [], fragments: {}, extra: true }),
		).toThrow(/authority Unrecognized key\(s\) in object: 'extra'/);
	});
});
