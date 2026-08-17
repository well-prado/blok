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

import { bounded } from "./bootTimeout.js";

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
	/** `host:port` (or similar), for the timeout diagnostic below. */
	endpoint?: string;
}

/**
 * #868 — sibling of #752 (HttpTrigger.listen()): every await on the boot path
 * needs a way to FAIL, not just hang. An unreachable/wedged runtime sidecar's
 * `listNodes()` can otherwise never settle, stalling boot (and the
 * `/__blok/nodes` route) forever with no error, no exit, no diagnostic.
 * The race itself lives in {@link bounded} (`bootTimeout.ts`) since #873.
 */
const LIST_NODES_TIMEOUT_MS = 5_000; // ponytail: fixed cap; make it BLOK_NODE_CATALOG_TIMEOUT_MS-configurable if a real sidecar ever needs longer just to enumerate its nodes

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
 * One unreachable OR wedged runtime can't break the catalog: its `listNodes()`
 * is bounded to {@link LIST_NODES_TIMEOUT_MS} (#868) and any failure —
 * rejection or timeout — is skipped with a loud `console.warn` naming the
 * runtime and its endpoint, rather than swallowed silently or left to hang.
 * Degrading (vs. failing boot) is deliberate: a step referencing a skipped
 * runtime's node just becomes "unchecked" for `#691` boot ref-validation
 * (never a false error — see `nodeSchemaLookup`), and real execution never
 * consults this catalog at all (`runtimeResolver` dials the adapter directly
 * at request time and fails there, on its own terms, if the sidecar is still
 * down). Sorted by runtime then name for stable output.
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
			const nodes = await bounded(adapter.listNodes(), LIST_NODES_TIMEOUT_MS, "listNodes()");
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
		} catch (err) {
			// Loud, not silent — an operator staring at an incomplete catalog
			// (or a boot that used to just hang) needs to know WHICH runtime is
			// the culprit and WHERE it lives.
			const reason = err instanceof Error ? err.message : String(err);
			console.warn(
				`[blok][node-catalog] runtime "${kind}" (${adapter.endpoint ?? "unknown endpoint"}) is unreachable — skipping its nodes: ${reason}`,
			);
		}
	}

	out.sort((a, b) => a.runtime.localeCompare(b.runtime) || a.name.localeCompare(b.name));
	return out;
}
