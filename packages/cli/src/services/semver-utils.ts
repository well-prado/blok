/**
 * Semver utilities for runtime version management.
 *
 * Provides parsing, comparison, constraint checking, and error formatting
 * for runtime version strings used across the Blok CLI and runner.
 */

export interface SemverParts {
	major: number;
	minor: number;
	patch: number;
}

export interface ParsedConstraint {
	operator: ">=" | "^" | "~" | "=" | "";
	version: string;
	parts: SemverParts;
}

/**
 * Parse a version string like "3.12.0" or "1.22" into numeric parts.
 * Missing patch defaults to 0; missing minor defaults to 0.
 */
export function parseSemver(version: string): SemverParts {
	const cleaned = version.trim();
	const parts = cleaned.split(".").map(Number);

	return {
		major: parts[0] || 0,
		minor: parts[1] || 0,
		patch: parts[2] || 0,
	};
}

/**
 * Compare two semver strings.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareSemver(a: string, b: string): number {
	const pa = parseSemver(a);
	const pb = parseSemver(b);

	if (pa.major !== pb.major) return pa.major - pb.major;
	if (pa.minor !== pb.minor) return pa.minor - pb.minor;
	return pa.patch - pb.patch;
}

/**
 * Check if version (a) >= version (b) using numeric parts.
 */
export function semverGte(a: SemverParts, b: SemverParts): boolean {
	if (a.major !== b.major) return a.major > b.major;
	if (a.minor !== b.minor) return a.minor > b.minor;
	return a.patch >= b.patch;
}

/**
 * Parse a constraint string like ">=3.10.0", "^1.22.0", "~1.22.0", or "3.12.0".
 */
export function parseConstraint(constraint: string): ParsedConstraint {
	const trimmed = constraint.trim();

	if (trimmed.startsWith(">=")) {
		const ver = trimmed.slice(2);
		return { operator: ">=", version: ver, parts: parseSemver(ver) };
	}
	if (trimmed.startsWith("^")) {
		const ver = trimmed.slice(1);
		return { operator: "^", version: ver, parts: parseSemver(ver) };
	}
	if (trimmed.startsWith("~")) {
		const ver = trimmed.slice(1);
		return { operator: "~", version: ver, parts: parseSemver(ver) };
	}

	// Exact version (or "=X.Y.Z")
	const ver = trimmed.startsWith("=") ? trimmed.slice(1) : trimmed;
	return { operator: trimmed.startsWith("=") ? "=" : "", version: ver, parts: parseSemver(ver) };
}

/**
 * Check whether a version string satisfies a constraint.
 *
 * Supported constraint formats:
 * - ">=3.10.0"  — minimum version (actual must be >= constraint)
 * - "^1.22.0"   — caret: same major, version >= constraint (^0.x.y has special handling)
 * - "~1.22.0"   — tilde: same major.minor, version >= constraint
 * - "3.12.0"    — exact match
 * - "=3.12.0"   — explicit exact match
 */
export function satisfiesConstraint(version: string, constraint: string): boolean {
	const actual = parseSemver(version);
	const parsed = parseConstraint(constraint);
	const base = parsed.parts;

	switch (parsed.operator) {
		case ">=":
			return semverGte(actual, base);

		case "^": {
			// Caret: allows changes that do not modify the left-most non-zero digit
			// ^1.2.3 := >=1.2.3 <2.0.0
			// ^0.2.3 := >=0.2.3 <0.3.0
			// ^0.0.3 := >=0.0.3 <0.0.4
			if (base.major !== 0) {
				return actual.major === base.major && semverGte(actual, base);
			}
			if (base.minor !== 0) {
				return actual.major === 0 && actual.minor === base.minor && actual.patch >= base.patch;
			}
			return actual.major === 0 && actual.minor === 0 && actual.patch === base.patch;
		}

		case "~":
			// Tilde: allows patch-level changes
			// ~1.2.3 := >=1.2.3 <1.3.0
			return actual.major === base.major && actual.minor === base.minor && actual.patch >= base.patch;

		case "=":
		case "":
			// Exact match
			return actual.major === base.major && actual.minor === base.minor && actual.patch === base.patch;

		default:
			return false;
	}
}

/**
 * Compute the default version constraint from a detected version.
 * Given "3.12.4", returns ">=3.12.0" (pins to major.minor, allows patch updates).
 */
export function computeDefaultConstraint(version: string): string {
	const parts = parseSemver(version);
	return `>=${parts.major}.${parts.minor}.0`;
}

/**
 * Format a user-friendly version mismatch error message.
 *
 * @param runtime - Human-readable runtime label (e.g. "Python 3")
 * @param found - Detected version string, or undefined if not installed
 * @param required - The constraint string (e.g. ">=3.10.0")
 * @param installHint - Installation hint URL or command
 * @returns Multi-line formatted error string
 */
export function formatVersionMismatch(
	runtime: string,
	found: string | undefined,
	required: string,
	installHint?: string,
): string {
	const lines = [`  x ${runtime}`, `    Required: ${required}`, `    Found:    ${found || "not installed"}`];

	if (installHint) {
		lines.push(`    Fix:      ${installHint}`);
	}
	lines.push("              Or update constraint in .blok/config.json");

	return lines.join("\n");
}

/**
 * Format a success message for a satisfied version constraint.
 *
 * @param runtime - Human-readable runtime label
 * @param found - Detected version string
 * @param required - The constraint string
 * @returns Single-line success string
 */
export function formatVersionSuccess(runtime: string, found: string, required: string): string {
	return `  ✓ ${runtime}  ${found} (requires ${required})`;
}
