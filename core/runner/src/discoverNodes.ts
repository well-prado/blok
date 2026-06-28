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
 * Deliberately shallow + convention-bound, NOT a recursive scan of arbitrary
 * files: the dev app's irregular example bundle (multiple nodes per dir, mixed
 * helper files) stays explicitly registered. A missing dir is not an error — a
 * project with no local nodes simply gets `[]`.
 *
 * ponytail: one-level `<name>/index.*` glob, instances used directly (no `new` —
 * defineNode already returns an instance, matching how Nodes.ts uses the
 * defaults). Upgrade path if nested node layouts are needed: recurse + accept a
 * configurable entry glob.
 */
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
		const node = mod.default as (NodeBase & { name?: unknown }) | undefined;
		// Only register a default export that looks like a node (has a string
		// `name`). A barrel/helper index (e.g. an `examples/index.ts` re-export
		// map) is silently skipped — it's registered explicitly elsewhere, and a
		// genuinely-broken user node surfaces as "Node <ref> not found" at use time.
		if (node && typeof node.name === "string" && node.name.length > 0) {
			found.push(node);
		}
	}
	return found;
}
