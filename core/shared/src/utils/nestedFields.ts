/**
 * Bracket-key expansion for form bodies (#1016).
 *
 * A browser form — and the stock Inertia client's `objectToFormData` — flattens
 * structure into the field NAME: `user[name]`, `tags[0]`, `tags[1]`, `files[]`.
 * Left flat, `req.body` is `{"user[name]": "a"}`, which no Zod schema for
 * `{ user: { name } }` can accept. This turns those names back into the object
 * the author wrote, for multipart AND urlencoded bodies alike.
 *
 * Deliberate limits (no `qs` dependency for this):
 * - depth cap of {@link MAX_FIELD_DEPTH} segments; deeper keys stay flat,
 * - `[0]` / `[1]` / `[]` make arrays, dense and in encounter order,
 * - a key used as both a leaf and a container (`a=1` plus `a[b]=2`) falls back
 *   to the flat key rather than guessing,
 * - `__proto__` / `constructor` / `prototype` anywhere in a key drops the whole
 *   entry — a form field must never reach an object's prototype chain.
 */

/** Key segments refused outright, at any depth. */
export const UNSAFE_KEY_SEGMENTS: readonly string[] = ["__proto__", "constructor", "prototype"];

/** Maximum number of segments (`a[b][c]` is 3) that still expands. */
export const MAX_FIELD_DEPTH = 5;

/** `name`, `name[sub]`, `name[0]`, `name[]`, nested — anything else stays flat. */
const BRACKET_KEY = /^([^[\]]+)((?:\[[^[\]]*\])*)$/;
const BRACKET_SEGMENT = /\[([^[\]]*)\]/g;
const INDEX = /^\d+$/;

class Group {
	readonly children = new Map<string, Group | Leaf>();
	/** Still a candidate for an array — cleared by the first non-numeric key. */
	arrayLike = true;
	/** Next index handed out to a `[]` (push) segment. */
	next = 0;
}

class Leaf {
	constructor(readonly value: unknown) {}
}

/** Split `a[b][0][]` into `["a", "b", "0", ""]`. `null` when the key is flat. */
function splitKey(key: string): string[] | null {
	const match = BRACKET_KEY.exec(key);
	if (!match?.[2]) return null;
	const segments = [match[1]];
	for (const bracket of match[2].matchAll(BRACKET_SEGMENT)) segments.push(bracket[1]);
	return segments;
}

function isUnsafe(segments: readonly string[]): boolean {
	return segments.some((segment) => UNSAFE_KEY_SEGMENTS.includes(segment));
}

/** Record the segment against `node`, returning the map key it uses. */
function claim(node: Group, segment: string): string {
	if (segment === "") return String(node.next++);
	if (INDEX.test(segment)) {
		node.next = Math.max(node.next, Number(segment) + 1);
		return segment;
	}
	node.arrayLike = false;
	return segment;
}

/** Walk the segments, creating groups. `false` = mixed usage, keep it flat. */
function insert(root: Group, segments: readonly string[], value: unknown): boolean {
	let node = root;
	for (const segment of segments.slice(0, -1)) {
		const key = claim(node, segment);
		const existing = node.children.get(key);
		if (existing instanceof Leaf) return false;
		if (existing) {
			node = existing;
			continue;
		}
		const child = new Group();
		node.children.set(key, child);
		node = child;
	}
	const key = claim(node, segments[segments.length - 1]);
	if (node.children.get(key) instanceof Group) return false;
	node.children.set(key, new Leaf(value));
	return true;
}

function materialize(node: Group): unknown {
	const keys = [...node.children.keys()];
	if (node.arrayLike && keys.length > 0 && keys.every((key) => INDEX.test(key))) {
		return keys
			.map(Number)
			.sort((a, b) => a - b)
			.map((index) => {
				const child = node.children.get(String(index));
				return child instanceof Group ? materialize(child) : (child as Leaf).value;
			});
	}
	const out: Record<string, unknown> = {};
	for (const [key, child] of node.children) {
		out[key] = child instanceof Group ? materialize(child) : child.value;
	}
	return out;
}

/**
 * Expand an ORDERED list of form entries into a nested object.
 *
 * Ordered, not a record, because duplicates carry meaning: two `tags[]` parts
 * are an array, two `tag` parts are last-wins (what Hono's `parseBody` does).
 */
export function expandFormEntries(
	entries: Iterable<readonly [string, unknown]>,
	maxDepth: number = MAX_FIELD_DEPTH,
): Record<string, unknown> {
	const root = new Group();
	root.arrayLike = false; // the top level is always an object
	for (const [key, value] of entries) {
		const segments = splitKey(key);
		if (isUnsafe(segments ?? [key])) continue;
		if (segments && segments.length <= maxDepth && insert(root, segments, value)) continue;
		root.children.set(key, new Leaf(value));
	}
	return materialize(root) as Record<string, unknown>;
}
