let _nonInteractive = false;

export function isNonInteractive(): boolean {
	return _nonInteractive || process.env.BLOK_NON_INTERACTIVE === "1";
}

export function setNonInteractive(value: boolean): void {
	_nonInteractive = value;
}

/**
 * Resolve a value: use flag if provided, otherwise fall through to interactive prompt.
 * In non-interactive mode, throws if no flag value and no default.
 */
export function resolveOrThrow<T>(flagName: string, flagValue: T | undefined, defaultValue?: T): T {
	if (flagValue !== undefined) return flagValue;
	if (defaultValue !== undefined) return defaultValue;
	if (isNonInteractive()) {
		throw new Error(
			`Missing required flag --${flagName} (non-interactive mode). ` +
				`Run without --non-interactive to use interactive prompts, or provide --${flagName}.`,
		);
	}
	return undefined as T;
}

/**
 * Validate that a value is one of the allowed options.
 */
export function validateChoice<T extends string>(flagName: string, value: T, allowed: readonly T[]): T {
	if (!allowed.includes(value)) {
		throw new Error(`Invalid value "${value}" for --${flagName}. Allowed: ${allowed.join(", ")}`);
	}
	return value;
}

/**
 * Parse comma-separated string into array.
 */
export function parseCommaSeparated(value: string): string[] {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}
