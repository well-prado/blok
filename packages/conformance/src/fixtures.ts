import type {
	CapabilityAuthority,
	CapabilityManifestV1,
	GraphIndexFile,
	GraphScope,
	PolicyDecision,
	PolicyRequest,
} from "@blokjs/shared";

export const agentManifest: CapabilityManifestV1 = {
	version: "1",
	classification: "agent-compatible",
	effects: ["read", "write"],
	capabilities: ["workspace.read", "workspace.write"],
	secrets: [],
	determinism: "external",
	idempotency: "idempotent",
	maturity: "stable",
};

export const parentAuthority: CapabilityAuthority = {
	effects: ["read", "write", "network"],
	capabilities: ["workspace.read", "workspace.write", "network.http"],
	secrets: [],
	fragments: { workspace: "repo-a" },
};

export const cleanGraphScope: GraphScope = {
	repository: { provider: "fixture", id: "repo-a" },
	worktree: { id: "worktree-1", branch: "main", commit: "commit-1", dirty: false, overlay: "clean" },
	commit: "commit-1",
};

export const graphFiles: readonly GraphIndexFile[] = [
	{
		path: "src/a.ts",
		contentHash: `sha256:${"a".repeat(64)}`,
		symbols: [
			{
				id: "src/a.ts:alpha",
				name: "alpha",
				kind: "function",
				language: "typescript",
				location: {
					path: "src/a.ts",
					range: { start: { line: 1, column: 1 }, end: { line: 3, column: 2 } },
					contentHash: `sha256:${"a".repeat(64)}`,
				},
			},
		],
		relations: [],
	},
];

export function interactionRequest(id: string): PolicyRequest {
	return {
		requestId: id,
		origin: "agent",
		principal: { id: "principal-1", kind: "agent" },
		session: { id: "session-1" },
		turn: { id: "turn-1" },
		workflow: { name: "conformance", version: "1" },
		step: { id: "approval", attempt: 1 },
		manifest: agentManifest,
		scope: { ...parentAuthority, fragments: { workspace: "repo-a", token: "CANARY" } },
		layers: [{ name: "phase", version: "1" }],
	};
}

export const askDecision: PolicyDecision = {
	kind: "ask",
	id: "decision-1",
	reasonCode: "approval",
	policyVersion: "1",
	reason: "approve token=CANARY",
};
