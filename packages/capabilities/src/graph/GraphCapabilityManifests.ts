import type { CapabilityManifestV1 } from "@blokjs/shared";

/** Existing H0-02 vocabulary for graph queries; authorization stays with PolicyProvider. */
export const GRAPH_QUERY_CAPABILITY_MANIFEST: CapabilityManifestV1 = Object.freeze({
	version: "1",
	classification: "agent-compatible",
	effects: ["read"] as CapabilityManifestV1["effects"],
	capabilities: ["graph.query"],
	secrets: [],
	determinism: "external",
	idempotency: "idempotent",
	maturity: "experimental",
});

/** Index persistence is a derived-index write, never a workspace/source write. */
export const GRAPH_INDEX_CAPABILITY_MANIFEST: CapabilityManifestV1 = Object.freeze({
	version: "1",
	classification: "agent-compatible",
	effects: ["read", "write"] as CapabilityManifestV1["effects"],
	capabilities: ["graph.index"],
	secrets: [],
	determinism: "external",
	idempotency: "conditionally-idempotent",
	maturity: "experimental",
});
