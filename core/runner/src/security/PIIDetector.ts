/**
 * PII Detection and Masking for Blok Framework
 *
 * Detects and masks personally identifiable information (PII) in text and
 * structured data:
 * - Built-in patterns for email, phone, SSN, credit card, IP address, etc.
 * - Luhn-algorithm-aware credit card detection
 * - Configurable masking characters and length preservation
 * - Deep object scanning with recursive string masking
 * - Custom pattern support for domain-specific PII
 *
 * @example
 * ```typescript
 * import { PIIDetector, PIIType } from "@blok/runner";
 *
 * const detector = new PIIDetector({
 *   types: [PIIType.EMAIL, PIIType.PHONE, PIIType.SSN, PIIType.CREDIT_CARD],
 *   maskChar: "*",
 *   preserveLength: true,
 * });
 *
 * // Detect PII in text
 * const matches = detector.detect("Contact john@example.com or 555-123-4567");
 *
 * // Mask PII in text
 * const masked = detector.mask("SSN: 123-45-6789");
 * // => "SSN: ***-**-****"
 *
 * // Deep scan an object
 * const result = detector.scan({ name: "John", email: "john@example.com" });
 * console.log(result.totalMatches); // 1
 * ```
 */

// ---------------------------------------------------------------------------
// Types & Enums
// ---------------------------------------------------------------------------

/**
 * Categories of personally identifiable information that can be detected.
 */
export enum PIIType {
	/** Email addresses (RFC 5322 simplified) */
	EMAIL = "EMAIL",
	/** Phone numbers (US and international formats) */
	PHONE = "PHONE",
	/** US Social Security Numbers */
	SSN = "SSN",
	/** Credit/debit card numbers (Luhn-validated) */
	CREDIT_CARD = "CREDIT_CARD",
	/** IPv4 and IPv6 addresses */
	IP_ADDRESS = "IP_ADDRESS",
	/** Dates of birth in common formats */
	DATE_OF_BIRTH = "DATE_OF_BIRTH",
	/** Person names (basic heuristic) */
	NAME = "NAME",
	/** Physical / mailing addresses (basic heuristic) */
	ADDRESS = "ADDRESS",
	/** Passport numbers (basic patterns) */
	PASSPORT = "PASSPORT",
	/** User-defined custom pattern */
	CUSTOM = "CUSTOM",
}

/**
 * A custom PII pattern definition.
 */
export interface PIIPattern {
	/** Identifier for this pattern (used as type label) */
	type: string;
	/** Regular expression to match the PII */
	pattern: RegExp;
	/** Function to produce the masked replacement for a match */
	mask: (match: string) => string;
}

/**
 * A single PII match found in text.
 */
export interface PIIMatch {
	/** The category of PII detected */
	type: PIIType;
	/** The original matched value */
	value: string;
	/** The masked replacement value */
	masked: string;
	/** Start index (inclusive) in the source string */
	start: number;
	/** End index (exclusive) in the source string */
	end: number;
}

/**
 * Result of a full PII scan.
 */
export interface PIIScanResult {
	/** Total number of PII matches found */
	totalMatches: number;
	/** Count of matches grouped by PII type */
	matchesByType: Record<string, number>;
	/** Whether any PII was detected */
	hasPII: boolean;
	/** Detailed list of every match */
	details: PIIMatch[];
}

/**
 * Configuration for the {@link PIIDetector} class.
 */
export interface PIIDetectorConfig {
	/**
	 * Built-in PII types to detect.
	 * @default All built-in types
	 */
	types?: PIIType[];

	/**
	 * Additional custom patterns to detect.
	 */
	customPatterns?: PIIPattern[];

	/**
	 * Character used for masking.
	 * @default "*"
	 */
	maskChar?: string;

	/**
	 * Whether the masked output should preserve the original length.
	 * When false, a fixed-length mask is used.
	 * @default true
	 */
	preserveLength?: boolean;
}

// ---------------------------------------------------------------------------
// Built-in patterns
// ---------------------------------------------------------------------------

/**
 * Internal definition of a built-in PII detector rule.
 */
interface BuiltInRule {
	type: PIIType;
	pattern: RegExp;
	/** Optional post-match validator (e.g. Luhn check for credit cards) */
	validate?: (match: string) => boolean;
}

/**
 * Luhn algorithm check for credit card number validation.
 *
 * @param digits - String of digits (spaces/dashes stripped)
 * @returns True if the number passes the Luhn check
 */
function luhnCheck(digits: string): boolean {
	const nums = digits.replace(/\D/g, "");
	if (nums.length < 13 || nums.length > 19) return false;

	let sum = 0;
	let alternate = false;
	for (let i = nums.length - 1; i >= 0; i--) {
		let n = Number.parseInt(nums[i], 10);
		if (alternate) {
			n *= 2;
			if (n > 9) n -= 9;
		}
		sum += n;
		alternate = !alternate;
	}
	return sum % 10 === 0;
}

const BUILT_IN_RULES: BuiltInRule[] = [
	{
		type: PIIType.EMAIL,
		// Simplified RFC 5322 email pattern
		pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
	},
	{
		type: PIIType.PHONE,
		// US formats: (555) 123-4567, 555-123-4567, +1-555-123-4567
		// International: +44 20 7946 0958, +49 30 1234567
		pattern: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{4}/g,
	},
	{
		type: PIIType.SSN,
		// US SSN: 123-45-6789 or 123456789
		pattern: /\b\d{3}-\d{2}-\d{4}\b|\b\d{9}\b/g,
	},
	{
		type: PIIType.CREDIT_CARD,
		// 13-19 digit numbers, optionally separated by spaces or dashes
		pattern: /\b(?:\d[ -]*?){13,19}\b/g,
		validate: (match: string) => luhnCheck(match),
	},
	{
		type: PIIType.IP_ADDRESS,
		// IPv4
		pattern:
			/\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b|(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}/g,
	},
	{
		type: PIIType.DATE_OF_BIRTH,
		// Common DOB formats: MM/DD/YYYY, DD-MM-YYYY, YYYY-MM-DD
		pattern: /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2})\b/g,
	},
	{
		type: PIIType.PASSPORT,
		// Simple passport patterns (US: 9 digits; UK: 9 digits; generic alphanumeric 6-9)
		pattern: /\b[A-Z]{1,2}\d{6,9}\b/g,
	},
];

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Detects and masks personally identifiable information (PII) in text and
 * structured data.
 *
 * The detector ships with built-in patterns for common PII categories and
 * supports custom user-defined patterns.  Credit card detection includes
 * Luhn algorithm validation to reduce false positives.
 *
 * @example
 * ```typescript
 * const detector = new PIIDetector();
 * const matches = detector.detect("Email me at test@example.com");
 * console.log(matches[0].type); // PIIType.EMAIL
 * ```
 */
export class PIIDetector {
	private readonly types: Set<PIIType>;
	private readonly customPatterns: PIIPattern[];
	private readonly maskChar: string;
	private readonly preserveLength: boolean;

	/**
	 * Create a new PIIDetector instance.
	 *
	 * @param config - Optional configuration overrides
	 */
	constructor(config?: PIIDetectorConfig) {
		this.types = new Set(
			config?.types ?? [
				PIIType.EMAIL,
				PIIType.PHONE,
				PIIType.SSN,
				PIIType.CREDIT_CARD,
				PIIType.IP_ADDRESS,
				PIIType.DATE_OF_BIRTH,
				PIIType.PASSPORT,
			],
		);
		this.customPatterns = config?.customPatterns ?? [];
		this.maskChar = config?.maskChar ?? "*";
		this.preserveLength = config?.preserveLength ?? true;
	}

	// -----------------------------------------------------------------------
	// Public API
	// -----------------------------------------------------------------------

	/**
	 * Detect all PII occurrences in a text string.
	 *
	 * Returns an array of {@link PIIMatch} objects describing every match,
	 * including position information and masked values.
	 *
	 * @param text - The text to scan for PII
	 * @returns Array of PII matches sorted by start position
	 *
	 * @example
	 * ```typescript
	 * const matches = detector.detect("SSN: 123-45-6789, email: a@b.com");
	 * // matches.length === 2
	 * ```
	 */
	detect(text: string): PIIMatch[] {
		const matches: PIIMatch[] = [];

		// Run built-in rules
		for (const rule of BUILT_IN_RULES) {
			if (!this.types.has(rule.type)) continue;

			// Reset lastIndex for global regexes
			const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
			let match: RegExpExecArray | null = regex.exec(text);

			while (match !== null) {
				const value = match[0];

				// Apply optional validator (e.g. Luhn for credit cards)
				if (rule.validate && !rule.validate(value)) {
					match = regex.exec(text);
					continue;
				}

				matches.push({
					type: rule.type,
					value,
					masked: this.maskValue(value),
					start: match.index,
					end: match.index + value.length,
				});
				match = regex.exec(text);
			}
		}

		// Run custom patterns
		for (const custom of this.customPatterns) {
			const regex = new RegExp(custom.pattern.source, custom.pattern.flags);
			let match: RegExpExecArray | null = regex.exec(text);

			while (match !== null) {
				const value = match[0];
				matches.push({
					type: PIIType.CUSTOM,
					value,
					masked: custom.mask(value),
					start: match.index,
					end: match.index + value.length,
				});
				match = regex.exec(text);
			}
		}

		// Sort by position in text
		matches.sort((a, b) => a.start - b.start);
		return matches;
	}

	/**
	 * Mask all detected PII in a text string.
	 *
	 * Replaces every detected PII occurrence with its masked equivalent.
	 * Non-overlapping replacements are applied from right to left to preserve
	 * string positions.
	 *
	 * @param text - The text containing PII to mask
	 * @returns The text with all PII replaced by masked values
	 *
	 * @example
	 * ```typescript
	 * const masked = detector.mask("Call 555-123-4567");
	 * // => "Call ************"
	 * ```
	 */
	mask(text: string): string {
		const matches = this.detect(text);
		if (matches.length === 0) return text;

		// Apply replacements from right to left to preserve indices
		let result = text;
		for (let i = matches.length - 1; i >= 0; i--) {
			const m = matches[i];
			result = result.slice(0, m.start) + m.masked + result.slice(m.end);
		}
		return result;
	}

	/**
	 * Deep-clone an object and mask all PII found in string values.
	 *
	 * Recursively traverses the object tree.  Every string property is run
	 * through {@link mask}.  Non-string primitives, arrays, and nested objects
	 * are handled transparently.
	 *
	 * @typeParam T - Type of the input object
	 * @param obj - The object to scan and mask
	 * @returns A deep clone with all string values masked
	 *
	 * @example
	 * ```typescript
	 * const safe = detector.maskObject({ email: "john@example.com", age: 30 });
	 * // safe.email === "****************"
	 * ```
	 */
	maskObject<T>(obj: T): T {
		return this.deepMask(obj) as T;
	}

	/**
	 * Perform a full PII scan on arbitrary data and return a summary report.
	 *
	 * Accepts strings, objects, arrays, or any JSON-compatible value.
	 * Strings are scanned directly; objects are serialized and scanned.
	 *
	 * @param data - The data to scan (string, object, array, or primitive)
	 * @returns A {@link PIIScanResult} with totals, type breakdown, and details
	 *
	 * @example
	 * ```typescript
	 * const report = detector.scan({
	 *   user: { email: "a@b.com", phone: "555-123-4567" },
	 * });
	 * console.log(report.hasPII); // true
	 * console.log(report.totalMatches); // 2
	 * ```
	 */
	scan(data: unknown): PIIScanResult {
		const text = typeof data === "string" ? data : JSON.stringify(data);
		const details = this.detect(text);

		const matchesByType: Record<string, number> = {};
		for (const match of details) {
			matchesByType[match.type] = (matchesByType[match.type] ?? 0) + 1;
		}

		return {
			totalMatches: details.length,
			matchesByType,
			hasPII: details.length > 0,
			details,
		};
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	/**
	 * Produce a masked string for a PII value.
	 *
	 * @param value - The original PII string
	 * @returns Masked string using the configured mask character
	 */
	private maskValue(value: string): string {
		if (this.preserveLength) {
			return value.replace(/[^\s\-/]/g, this.maskChar);
		}
		// Fixed-length mask (8 characters)
		return this.maskChar.repeat(8);
	}

	/**
	 * Recursively deep-clone and mask all string values in a value.
	 *
	 * @param value - Any JSON-compatible value
	 * @returns Deep-cloned value with strings masked
	 */
	private deepMask(value: unknown): unknown {
		if (value === null || value === undefined) return value;

		if (typeof value === "string") {
			return this.mask(value);
		}

		if (Array.isArray(value)) {
			return value.map((item) => this.deepMask(item));
		}

		if (typeof value === "object") {
			const result: Record<string, unknown> = {};
			for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
				result[key] = this.deepMask(val);
			}
			return result;
		}

		// Primitives (number, boolean) pass through
		return value;
	}
}
