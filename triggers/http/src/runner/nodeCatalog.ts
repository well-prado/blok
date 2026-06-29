/**
 * Node catalog (SPEC-B P1.3) — aggregates every node across all runtimes into a
 * uniform list for `GET /__blok/nodes` + `blokctl nodes list`.
 *
 * Two sources:
 *  - **Module (in-process) nodes** — read from the trigger's node map; their
 *    JSON Schema comes from `defineNode`'s `getReflectionSchemas()` (real) or a
 *    class node's `getSchemas()`.
 *  - **Runtime nodes** — each connected runtime adapter's `listNodes()` (the
 *    gRPC `ListNodes` RPC). Schemas are populated per-SDK in SPEC-B P2/P3; until
 *    then they're `null`.
 *
 * Pure + structurally typed so it's unit-testable without booting a server.
 */

/** One node in the catalog. */
export interface NodeCatalogEntry {
	name: string;
	/**
	 * The exact resolvable string an author puts in a step's `use:`.
	 * Module nodes → the registry Map key (e.g. "@blokjs/api-call", NOT the
	 * display `name`). Runtime nodes → "runtime.<kind>:<name>" (per inferStepType).
	 */
	ref: string;
	/** "module" for in-process nodes, "runtime.<kind>" for SDK runtimes. */
	runtime: string;
	description?: string;
	/** Parsed JSON Schema, or null when the node/SDK doesn't expose one. */
	inputSchema: unknown | null;
	outputSchema: unknown | null;
	tags: string[];
}

interface ReflectableNode {
	name?: string;
	description?: string;
	getReflectionSchemas?: () => { input: unknown; output: unknown };
	getSchemas?: () => { input: unknown; output: unknown };
}

interface RuntimeNode {
	name: string;
	description?: string;
	inputSchema: unknown | null;
	outputSchema: unknown | null;
	tags?: string[];
}

interface ListableAdapter {
	listNodes?: () => Promise<RuntimeNode[]>;
}

/** An empty object (`{}`) means "no constraints" — surface it as null in the catalog. */
function normSchema(schema: unknown): unknown | null {
	return schema && typeof schema === "object" && Object.keys(schema as object).length > 0 ? schema : null;
}

/** Extract `{ name, description, inputSchema, outputSchema }` from an in-process node. */
export function reflectModuleNode(node: unknown): {
	name?: string;
	description?: string;
	inputSchema: unknown | null;
	outputSchema: unknown | null;
} {
	const n = node as ReflectableNode;
	let input: unknown | null = null;
	let output: unknown | null = null;
	if (typeof n.getReflectionSchemas === "function") {
		const s = n.getReflectionSchemas();
		input = normSchema(s.input);
		output = normSchema(s.output);
	} else if (typeof n.getSchemas === "function") {
		const s = n.getSchemas();
		input = normSchema(s.input);
		output = normSchema(s.output);
	}
	return { name: n.name, description: n.description, inputSchema: input, outputSchema: output };
}

/**
 * Build the full catalog from the in-process node map + the runtime adapters.
 * One unreachable runtime can't break the catalog (its `listNodes()` rejection
 * is swallowed). Sorted by runtime then name for stable output.
 */
export async function buildNodeCatalog(
	moduleNodes: Map<string, unknown> | undefined,
	runtimes: ReadonlyArray<{ kind: string; adapter: ListableAdapter }>,
): Promise<NodeCatalogEntry[]> {
	const out: NodeCatalogEntry[] = [];

	if (moduleNodes) {
		for (const [key, node] of moduleNodes) {
			const r = reflectModuleNode(node);
			out.push({
				name: r.name ?? key,
				ref: key, // the registry key is the resolvable `use` ref, not the display name
				runtime: "module",
				description: r.description,
				inputSchema: r.inputSchema,
				outputSchema: r.outputSchema,
				tags: [],
			});
		}
	}

	for (const { kind, adapter } of runtimes) {
		if (typeof adapter.listNodes !== "function") continue;
		try {
			const nodes = await adapter.listNodes();
			for (const n of nodes) {
				out.push({
					name: n.name,
					ref: `runtime.${kind}:${n.name}`, // resolvable `use` ref per inferStepType
					runtime: `runtime.${kind}`,
					description: n.description,
					inputSchema: n.inputSchema,
					outputSchema: n.outputSchema,
					tags: n.tags ?? [],
				});
			}
		} catch {
			/* skip an unreachable runtime — don't fail the whole catalog */
		}
	}

	out.sort((a, b) => a.runtime.localeCompare(b.runtime) || a.name.localeCompare(b.name));
	return out;
}
