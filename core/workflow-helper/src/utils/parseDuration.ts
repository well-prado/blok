/**
 * Parse a duration value to milliseconds.
 *
 * Accepts:
 *   - A non-negative finite number (interpreted as milliseconds)
 *   - A single-unit string: `"500ms"`, `"30s"`, `"5m"`, `"2h"`, `"1d"`
 *
 * Rejects:
 *   - Negative numbers, NaN, Infinity
 *   - Empty strings, whitespace-only strings
 *   - Multi-unit strings (`"1h30m"`) — split into separate fields if needed
 *   - Fractional values (`"1.5h"`) — express as a smaller unit (`"90m"`)
 *   - Unknown units (`"5y"`)
 *
 * The narrow grammar is deliberate: it makes parsing predictable and
 * round-trippable. For arbitrarily complex schedules, use the cron trigger.
 *
 * @example
 *   parseDuration(5000)      // → 5000
 *   parseDuration("500ms")   // → 500
 *   parseDuration("30s")     // → 30000
 *   parseDuration("5m")      // → 300000
 *   parseDuration("2h")      // → 7200000
 *   parseDuration("1d")      // → 86400000
 *
 * @throws Error with a helpful message identifying the offending input.
 */
export function parseDuration(input: number | string): number {
	if (typeof input === "number") {
		if (!Number.isFinite(input)) {
			throw new Error(`Invalid duration: ${input} (must be a finite number).`);
		}
		if (input < 0) {
			throw new Error(`Invalid duration: ${input} (must be >= 0).`);
		}
		// Allow fractional ms for raw numbers (e.g. precise jitter math).
		// Floor to integer ms — sub-ms scheduling is meaningless for setTimeout.
		return Math.floor(input);
	}

	if (typeof input !== "string") {
		throw new Error(`Invalid duration: ${typeof input} (must be a number or string).`);
	}

	const trimmed = input.trim();
	if (trimmed.length === 0) {
		throw new Error("Invalid duration: empty string.");
	}

	// Single-unit grammar: <integer><unit>
	// Units: ms (milliseconds), s (seconds), m (minutes), h (hours), d (days)
	const match = /^(\d+)(ms|s|m|h|d)$/.exec(trimmed);
	if (!match) {
		throw new Error(
			`Invalid duration: ${JSON.stringify(input)}. Expected a non-negative integer followed by a unit (ms, s, m, h, d), e.g. "500ms", "30s", "5m", "2h", "1d". Multi-unit strings ("1h30m") and fractional values ("1.5h") are not supported.`,
		);
	}

	const value = Number.parseInt(match[1], 10);
	const unit = match[2];

	const multipliers: Record<string, number> = {
		ms: 1,
		s: 1000,
		m: 60_000,
		h: 3_600_000,
		d: 86_400_000,
	};

	return value * multipliers[unit];
}

/**
 * Same as {@link parseDuration} but returns null instead of throwing on
 * invalid input. Useful when validating user-supplied config defensively.
 */
export function tryParseDuration(input: unknown): number | null {
	if (typeof input !== "number" && typeof input !== "string") return null;
	try {
		return parseDuration(input);
	} catch {
		return null;
	}
}
