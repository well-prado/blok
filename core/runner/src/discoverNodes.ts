import { existsSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { NodeBase } from "@blokjs/shared";

/**
 * Auto-discover local nodes under a directory — the "import = registration"
 * path that retires the hand-maintained `Nodes.ts` map for a project's own
 * nodes (#349 / #360, ADR 0002).
 *
 * Convention (what `blokctl create node` scaffolds): one node per subdirectory,
 * `<dir>/<name>/index.{ts,js,mjs}`, with a `defineNode(...)` instance as the
 * default export. Each discovered node is returned as-is; the caller registers
 * it under its own `node.name` (the canonical `use:` ref per ADR 0002), so the
 * `NodeMap` collision guard catches any two nodes claiming the same ref.
 *
 * Two default-export shapes register (#360 / #383):
 *   - a single `defineNode(...)` instance (default export has a string `name`);
 *   - a MAP-EXPORT barrel — `export default { "<ref>": node, ... }` — whose
 *     values are nodes. Each node value is registered (the dev app's
 *     `examples/`/`eval/` bundles and re-export maps). A barrel whose values
 *     are NOT node-shaped (a plain helper/util module) is skipped.
 *
 * Deliberately shallow + convention-bound, NOT a recursive scan of arbitrary
 * files. A missing dir is not an error — a project with no local nodes gets `[]`.
 *
 * ponytail: one-level `<name>/index.*` glob, instances used directly (no `new` —
 * defineNode already returns an instance). Upgrade path if nested node layouts
 * are needed: recurse + accept a configurable entry glob.
 */
const looksLikeNode = (v: unknown): v is NodeBase =>
	!!v &&
	typeof v === "object" &&
	typeof (v as { name?: unknown }).name === "string" &&
	(v as { name: string }).name.length > 0;
export async function discoverNodes(dir: string): Promise<NodeBase[]> {
	const base = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
	if (!existsSync(base) || !statSync(base).isDirectory()) return [];

	const found: NodeBase[] = [];
	for (const entry of readdirSync(base)) {
		const sub = join(base, entry);
		if (entry.startsWith(".") || entry.startsWith("_") || !statSync(sub).isDirectory()) continue;

		const file = ["index.ts", "index.js", "index.mjs"].map((f) => join(sub, f)).find(existsSync);
		if (!file) continue;

		const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
		const def = mod.default;
		if (looksLikeNode(def)) {
			// Single node per dir — the `blokctl create node` convention.
			found.push(def);
		} else if (def && typeof def === "object") {
			// Map-export barrel: register every node-shaped value (#360 / #383).
			// Non-node values (helper exports) are ignored, so a plain util
			// module default-exporting `{}`-of-non-nodes registers nothing.
			for (const v of Object.values(def as Record<string, unknown>)) {
				if (looksLikeNode(v)) found.push(v);
			}
		}
	}
	return found;
}
