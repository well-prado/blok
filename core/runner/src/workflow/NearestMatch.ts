/**
 * NearestMatch — shared "did you mean…?" ranking for every by-name /
 * by-route lookup that can fail: the HTTP catch-all (unknown path),
 * `POST /__blok/rpc/:name` (unknown workflow name), and `subworkflow:`
 * resolution (unknown child workflow name). #693.
 *
 * One edit-distance implementation, reused everywhere a lookup miss needs
 * to suggest the closest registered thing instead of just failing silent.
 * No dependency pulled in for this — classic Levenshtein DP is ~15 lines
 * and the repo has no fuzzy-matching library installed already.
 */

/** One thing a failed lookup could have meant. */
export interface MatchCandidate {
	/** String compared against the query (e.g. `"GET /orders"` or a workflow name). */
	readonly key: string;
	/** Human-readable form for the suggestion message (usually same as `key`). */
	readonly label: string;
	/** Defining file path, when known — surfaced as "(from <source>)". */
	readonly source?: string;
}

export interface RankedMatch extends MatchCandidate {
	readonly distance: number;
}

/** Classic Levenshtein edit distance (insert/delete/substitute), case-sensitive. */
export function levenshteinDistance(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	let prevRow = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const currRow = [i];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			currRow.push(Math.min(prevRow[j] + 1, currRow[j - 1] + 1, prevRow[j - 1] + cost));
		}
		prevRow = currRow;
	}
	return prevRow[b.length];
}

/**
 * Rank `candidates` by edit distance to `query` and return the closest
 * `limit` (default 3). Ties keep candidate order (stable sort).
 */
export function nearestMatches(query: string, candidates: readonly MatchCandidate[], limit = 3): RankedMatch[] {
	return candidates
		.map((c) => ({ ...c, distance: levenshteinDistance(query, c.key) }))
		.sort((a, b) => a.distance - b.distance)
		.slice(0, limit);
}
