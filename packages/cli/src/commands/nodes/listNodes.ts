import type { CapabilityManifestStatus, CapabilityManifestV1 } from "@blokjs/shared";
import type { OptionValues } from "commander";
import color from "picocolors";

/**
 * `blokctl nodes list` (SPEC-B P1.4) — print the node catalog of a running Blok
 * server by hitting `GET /__blok/nodes`. Lists every node across all runtimes
 * (in-process module nodes + each SDK runtime), with a schema indicator.
 */

/** One catalog entry, as returned by `GET /__blok/nodes`. */
export interface NodeEntry {
	name: string;
	/** The exact resolvable `use` string (module Map key, or `runtime.<kind>:<name>`). */
	ref?: string;
	runtime: string;
	description?: string;
	inputSchema: unknown | null;
	outputSchema: unknown | null;
	tags?: string[];
	capabilityManifest?: CapabilityManifestV1 | null;
	capabilityManifestStatus?: CapabilityManifestStatus;
	agentEligible?: boolean;
	agentEligibilityReason?: string;
}

/**
 * Fetch the node catalog from a running server's `GET /__blok/nodes`. Returns
 * the node list, or `null` after printing a diagnostic when the server is
 * unreachable / errors (the caller decides whether to `process.exit`). Shared by
 * `nodes list` and `nodes sync`.
 */
export async function fetchCatalog(url: string | undefined): Promise<NodeEntry[] | null> {
	const baseUrl = (url ?? "http://localhost:4000").replace(/\/+$/, "");
	const endpoint = `${baseUrl}/__blok/nodes`;
	try {
		const res = await fetch(endpoint);
		if (!res.ok) {
			console.log(color.red(`❌ ${endpoint} returned HTTP ${res.status}.`));
			return null;
		}
		const body = (await res.json()) as { nodes?: NodeEntry[] };
		return body.nodes ?? [];
	} catch (err) {
		console.log(
			color.red(
				`❌ Could not reach ${color.cyan(endpoint)} — is the Blok server running? ` +
					`Pass --url <baseUrl> to point elsewhere. (${(err as Error).message})`,
			),
		);
		return null;
	}
}

/** "in,out" / "in" / "out" / "—" depending on which schemas the node exposes. */
export function schemaMark(node: NodeEntry): string {
	const parts: string[] = [];
	if (node.inputSchema) parts.push("in");
	if (node.outputSchema) parts.push("out");
	return parts.length > 0 ? parts.join(",") : "—";
}

/** Render the catalog as an aligned plain-text table (pure — unit-testable). */
export function formatCatalog(nodes: readonly NodeEntry[]): string {
	if (nodes.length === 0) return "No nodes found.";
	const rows = nodes.map((n) => ({
		name: n.name,
		runtime: n.runtime,
		schema: schemaMark(n),
		effects: n.capabilityManifest?.effects.join(",") || "—",
		capabilities: n.capabilityManifest?.capabilities.join(",") || "—",
		description: n.description ?? "",
	}));
	const nameW = Math.max("NAME".length, ...rows.map((r) => r.name.length));
	const rtW = Math.max("RUNTIME".length, ...rows.map((r) => r.runtime.length));
	const schW = Math.max("SCHEMA".length, ...rows.map((r) => r.schema.length));
	const effectsW = Math.max("EFFECTS".length, ...rows.map((r) => r.effects.length));
	const capabilitiesW = Math.max("CAPABILITIES".length, ...rows.map((r) => r.capabilities.length));
	const header = `${"NAME".padEnd(nameW)}  ${"RUNTIME".padEnd(rtW)}  ${"SCHEMA".padEnd(schW)}  ${"EFFECTS".padEnd(effectsW)}  ${"CAPABILITIES".padEnd(capabilitiesW)}  DESCRIPTION`;
	const lines = [header];
	for (const r of rows) {
		lines.push(
			`${r.name.padEnd(nameW)}  ${r.runtime.padEnd(rtW)}  ${r.schema.padEnd(schW)}  ${r.effects.padEnd(effectsW)}  ${r.capabilities.padEnd(capabilitiesW)}  ${r.description}`.trimEnd(),
		);
	}
	return lines.join("\n");
}

/** CLI entrypoint. */
export async function listNodes(opts: OptionValues): Promise<void> {
	const baseUrl = ((opts.url as string | undefined) ?? "http://localhost:4000").replace(/\/+$/, "");
	const nodes = await fetchCatalog(opts.url as string | undefined);
	if (nodes === null) {
		// fetchCatalog already printed the diagnostic; this only sets the failure.
		throw new Error("Could not load the node catalog.");
	}

	if (opts.json === true) {
		console.log(JSON.stringify(nodes, null, 2));
		return;
	}

	console.log(color.cyan(`\n📦 Node catalog — ${nodes.length} node(s) across runtimes (${baseUrl})\n`));
	console.log(formatCatalog(nodes));
	console.log("");
}
