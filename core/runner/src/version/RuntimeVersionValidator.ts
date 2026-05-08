/**
 * RuntimeVersionValidator — Validates node and workflow runtime version requirements.
 *
 * Used by the runner to check that nodes' `runtimeRequirements` are satisfied
 * by the currently running runtime versions before executing workflows.
 */

export interface VersionValidationResult {
	valid: boolean;
	node: string;
	runtime: string;
	required: string;
	actual: string | undefined;
	message: string;
}

interface SemverParts {
	major: number;
	minor: number;
	patch: number;
}

function parseSemver(version: string): SemverParts {
	const parts = version.trim().split(".").map(Number);
	return {
		major: parts[0] || 0,
		minor: parts[1] || 0,
		patch: parts[2] || 0,
	};
}

function semverGte(a: SemverParts, b: SemverParts): boolean {
	if (a.major !== b.major) return a.major > b.major;
	if (a.minor !== b.minor) return a.minor > b.minor;
	return a.patch >= b.patch;
}

function satisfiesConstraint(version: string, constraint: string): boolean {
	const actual = parseSemver(version);
	const trimmed = constraint.trim();

	if (trimmed.startsWith(">=")) {
		return semverGte(actual, parseSemver(trimmed.slice(2)));
	}
	if (trimmed.startsWith("^")) {
		const base = parseSemver(trimmed.slice(1));
		if (base.major !== 0) {
			return actual.major === base.major && semverGte(actual, base);
		}
		if (base.minor !== 0) {
			return actual.major === 0 && actual.minor === base.minor && actual.patch >= base.patch;
		}
		return actual.major === 0 && actual.minor === 0 && actual.patch === base.patch;
	}
	if (trimmed.startsWith("~")) {
		const base = parseSemver(trimmed.slice(1));
		return actual.major === base.major && actual.minor === base.minor && actual.patch >= base.patch;
	}

	// Exact match
	const base = parseSemver(trimmed.startsWith("=") ? trimmed.slice(1) : trimmed);
	return actual.major === base.major && actual.minor === base.minor && actual.patch === base.patch;
}

export class RuntimeVersionValidator {
	private runtimeVersions: Map<string, string>;

	constructor(runtimeVersions?: Record<string, string>) {
		this.runtimeVersions = new Map(Object.entries(runtimeVersions || {}));
	}

	setRuntimeVersion(kind: string, version: string): void {
		this.runtimeVersions.set(kind, version);
	}

	getRuntimeVersion(kind: string): string | undefined {
		return this.runtimeVersions.get(kind);
	}

	/**
	 * Validate a single node's runtime requirements against known runtime versions.
	 */
	validateNode(node: {
		name: string;
		runtimeRequirements?: Partial<Record<string, string>>;
	}): VersionValidationResult[] {
		if (!node.runtimeRequirements) return [];

		const results: VersionValidationResult[] = [];

		for (const [runtime, constraint] of Object.entries(node.runtimeRequirements)) {
			if (!constraint) continue;

			const actual = this.runtimeVersions.get(runtime);

			if (!actual) {
				results.push({
					valid: false,
					node: node.name,
					runtime,
					required: constraint,
					actual: undefined,
					message:
						`Node "${node.name}" requires ${runtime} ${constraint}, ` + `but no ${runtime} runtime version is known.`,
				});
				continue;
			}

			const valid = satisfiesConstraint(actual, constraint);
			results.push({
				valid,
				node: node.name,
				runtime,
				required: constraint,
				actual,
				message: valid
					? `Node "${node.name}" ${runtime} ${constraint} satisfied (${actual})`
					: `Node "${node.name}" requires ${runtime} ${constraint}, but found ${actual}.`,
			});
		}

		return results;
	}

	/**
	 * Validate all nodes in a workflow against known runtime versions.
	 */
	validateWorkflow(
		nodes: Array<{
			name: string;
			runtimeRequirements?: Partial<Record<string, string>>;
		}>,
	): VersionValidationResult[] {
		const results: VersionValidationResult[] = [];
		for (const node of nodes) {
			results.push(...this.validateNode(node));
		}
		return results;
	}

	/**
	 * Format validation errors into a user-friendly multi-line string.
	 */
	static formatErrors(results: VersionValidationResult[]): string {
		const failures = results.filter((r) => !r.valid);
		if (failures.length === 0) return "";

		const lines = ["Runtime version requirements not met:"];
		for (const f of failures) {
			lines.push("");
			lines.push(`  Node: ${f.node}`);
			lines.push(`  Runtime: ${f.runtime}`);
			lines.push(`  Required: ${f.required}`);
			lines.push(`  Found: ${f.actual || "not available"}`);
		}
		return lines.join("\n");
	}
}
