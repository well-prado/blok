import type { MetadataFilter, MetadataOp } from "./types";

/**
 * F2 (v0.5) — shared metadata-filter helpers used by every RunStore.
 *
 * Two responsibilities:
 *   1. Normalise `RunQuery.metadata` (either back-compat
 *      `Record<string, string>` or the operator-aware `MetadataFilter[]`)
 *      into a single `MetadataFilter[]` the stores can iterate over.
 *   2. Evaluate a single filter against a metadata bag (in-memory case)
 *      OR translate it into a SQL fragment + bound params
 *      (sqlite/postgres case).
 *
 * Keep all of this in one place so we don't drift between the three
 * store implementations as new operators are added.
 */

/**
 * F2 — set of operators the URL parser + stores recognise. The literal
 * order matches the order I document them in `env-vars.mdx` /
 * `BACKLOG.md` so the docs and the code stay in lock-step.
 */
export const METADATA_OPERATORS: readonly MetadataOp[] = [
	"eq",
	"ne",
	"gt",
	"gte",
	"lt",
	"lte",
	"like",
	"in",
	"nin",
] as const;

/**
 * Same set as a Set for fast `has()` checks during URL parsing.
 */
const OPERATOR_SET = new Set<string>(METADATA_OPERATORS);

/**
 * `^[a-zA-Z0-9_-]+$` — JSON-path-safe key shape. Mirrors the regex
 * already used by the TraceRouter parser (and by `SqliteRunStore`'s
 * `json_extract(metadata_json, '$.<key>')` path) so the same keys are
 * accepted everywhere.
 */
const KEY_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Test-only export so the URL-parser tests can assert their key
 * validation matches the store layer's.
 */
export function isValidMetadataKey(key: string): boolean {
	return KEY_REGEX.test(key);
}

/**
 * Coerce a `RunQuery.metadata` value (either shape) into a flat array
 * of filters. Returns an empty array when the input is `undefined` /
 * empty so callers can `for ... of` it without a null check.
 *
 * Back-compat: a `Record<string, string>` value `{tier: "premium"}` is
 * normalised to `[{key: "tier", op: "eq", value: "premium"}]`. Keys
 * outside `^[a-zA-Z0-9_-]+$` are silently dropped — same contract as
 * the existing v0.4 behaviour.
 */
export function normaliseMetadataFilters(
	input: Record<string, string> | MetadataFilter[] | undefined,
): MetadataFilter[] {
	if (!input) return [];
	if (Array.isArray(input)) {
		return input.filter((f) => isValidMetadataKey(f.key) && OPERATOR_SET.has(f.op));
	}
	const out: MetadataFilter[] = [];
	for (const [key, value] of Object.entries(input)) {
		if (!isValidMetadataKey(key)) continue;
		out.push({ key, op: "eq", value });
	}
	return out;
}

/**
 * In-memory evaluator — used by `InMemoryRunStore` directly and by
 * `PostgresRunStore` (which delegates to the in-memory mirror). The
 * sqlite path translates filters to SQL via {@link translateFilterToSql}
 * instead.
 *
 * Returns true when the filter matches the metadata bag, false
 * otherwise. Missing keys never match (except `ne` and `nin`, which
 * intentionally match when the key is absent — "not equal to X" is
 * true for unset values, matching SQL `IS NULL OR value != X`).
 */
export function evaluateFilter(filter: MetadataFilter, metadata: Record<string, unknown> | undefined): boolean {
	const raw = metadata?.[filter.key];

	switch (filter.op) {
		case "eq":
			if (raw === undefined || raw === null) return false;
			return String(raw) === filter.value;
		case "ne":
			// SQL-equivalent contract: a missing key counts as "not equal".
			if (raw === undefined || raw === null) return true;
			return String(raw) !== filter.value;
		case "gt": {
			const { lhs, rhs } = coerceNumeric(raw, filter.value);
			if (lhs === null || rhs === null) return false;
			return lhs > rhs;
		}
		case "gte": {
			const { lhs, rhs } = coerceNumeric(raw, filter.value);
			if (lhs === null || rhs === null) return false;
			return lhs >= rhs;
		}
		case "lt": {
			const { lhs, rhs } = coerceNumeric(raw, filter.value);
			if (lhs === null || rhs === null) return false;
			return lhs < rhs;
		}
		case "lte": {
			const { lhs, rhs } = coerceNumeric(raw, filter.value);
			if (lhs === null || rhs === null) return false;
			return lhs <= rhs;
		}
		case "like": {
			if (raw === undefined || raw === null) return false;
			return likeMatches(String(raw), filter.value as string);
		}
		case "in": {
			if (raw === undefined || raw === null) return false;
			const list = Array.isArray(filter.value) ? filter.value : [filter.value];
			return list.includes(String(raw));
		}
		case "nin": {
			// "not in" parallels `ne`: a missing key satisfies the filter.
			if (raw === undefined || raw === null) return true;
			const list = Array.isArray(filter.value) ? filter.value : [filter.value];
			return !list.includes(String(raw));
		}
	}
}

/**
 * Translate a single filter to a SQL fragment + bound parameters for
 * the sqlite store. `lhs` is the SQL expression that yields the
 * metadata value (typically `json_extract(metadata_json, '$.<key>')`,
 * or a generated-column reference when F1's
 * `BLOK_INDEXED_METADATA_KEYS` includes the key).
 *
 * Returns `null` when the filter shape is invalid (e.g. `in` with an
 * empty array) so the caller can skip emitting it.
 */
export function translateFilterToSql(
	filter: MetadataFilter,
	lhs: string,
): { fragment: string; params: Array<string | number> } | null {
	switch (filter.op) {
		case "eq":
			return { fragment: `${lhs} = ?`, params: [filter.value as string] };
		case "ne":
			// `IS NULL OR != ?` — a missing key counts as "not equal".
			return { fragment: `(${lhs} IS NULL OR ${lhs} != ?)`, params: [filter.value as string] };
		case "gt":
			return { fragment: `CAST(${lhs} AS REAL) > ?`, params: [Number(filter.value)] };
		case "gte":
			return { fragment: `CAST(${lhs} AS REAL) >= ?`, params: [Number(filter.value)] };
		case "lt":
			return { fragment: `CAST(${lhs} AS REAL) < ?`, params: [Number(filter.value)] };
		case "lte":
			return { fragment: `CAST(${lhs} AS REAL) <= ?`, params: [Number(filter.value)] };
		case "like":
			return { fragment: `${lhs} LIKE ?`, params: [filter.value as string] };
		case "in": {
			const list = Array.isArray(filter.value) ? filter.value : [filter.value];
			if (list.length === 0) return null;
			const placeholders = list.map(() => "?").join(", ");
			return { fragment: `${lhs} IN (${placeholders})`, params: list };
		}
		case "nin": {
			const list = Array.isArray(filter.value) ? filter.value : [filter.value];
			if (list.length === 0) return null;
			const placeholders = list.map(() => "?").join(", ");
			return { fragment: `(${lhs} IS NULL OR ${lhs} NOT IN (${placeholders}))`, params: list };
		}
	}
}

/**
 * Try to coerce both sides of a numeric comparison to numbers. Returns
 * `{lhs: null, rhs: null}` when either side isn't a finite number —
 * the caller treats that as "filter doesn't match" (parity with the
 * SQL CAST behaviour, where a non-numeric text value casts to 0 but
 * we don't want to silently match that on the JS side).
 */
function coerceNumeric(rawLhs: unknown, rawRhs: string | string[]): { lhs: number | null; rhs: number | null } {
	const rhsRaw = Array.isArray(rawRhs) ? rawRhs[0] : rawRhs;
	const lhs = typeof rawLhs === "number" ? rawLhs : Number(rawLhs);
	const rhs = Number(rhsRaw);
	return {
		lhs: Number.isFinite(lhs) ? lhs : null,
		rhs: Number.isFinite(rhs) ? rhs : null,
	};
}

/**
 * SQL-`LIKE` semantics in JavaScript. `%` matches any sequence
 * (including empty), `_` matches exactly one character. Backslash
 * escaping is NOT supported — matches the SQLite default `LIKE`
 * (which only honours escape when an explicit `ESCAPE` clause is
 * given; the URL syntax doesn't expose one).
 */
function likeMatches(text: string, pattern: string): boolean {
	const escaped = pattern
		.split("")
		.map((c) => {
			if (c === "%") return ".*";
			if (c === "_") return ".";
			// Regex-escape every special character so the user's pattern
			// can't unintentionally inject regex syntax (e.g. parentheses
			// in a workflow name).
			if (/[.*+?^${}()|[\]\\]/.test(c)) return `\\${c}`;
			return c;
		})
		.join("");
	return new RegExp(`^${escaped}$`).test(text);
}
