/**
 * PromptVersioning - Tracks prompt versions for reproducibility and analytics
 *
 * Each system prompt has a versioned identifier so that:
 * - Generation results can be traced back to the exact prompt version
 * - A/B testing between prompt versions is possible
 * - Prompt improvements can be tracked against success rate metrics
 */

export interface PromptVersion {
	/** Unique identifier for this prompt (e.g., "create-fn-node") */
	id: string;
	/** Semantic version (e.g., "1.2.0") */
	version: string;
	/** Short description of what changed in this version */
	changelog: string;
	/** ISO 8601 timestamp when this version was created */
	createdAt: string;
	/** SHA-256 hash of the prompt content for integrity verification */
	contentHash: string;
}

export interface PromptRegistry {
	[promptId: string]: PromptVersion;
}

/**
 * Current prompt versions registry
 * Updated whenever a system prompt is modified
 */
export const PROMPT_VERSIONS: PromptRegistry = {
	"create-fn-node": {
		id: "create-fn-node",
		version: "2.0.0",
		changelog: "Function-first defineNode pattern with Zod schemas, 2 real-world examples",
		createdAt: "2026-01-28T00:00:00Z",
		contentHash: "", // Computed at runtime
	},
	"create-node": {
		id: "create-node",
		version: "1.0.0",
		changelog: "Class-based NanoService pattern with GlobalError handling",
		createdAt: "2026-01-27T00:00:00Z",
		contentHash: "",
	},
	"create-workflow": {
		id: "create-workflow",
		version: "2.0.0",
		changelog: "7 trigger types (HTTP, Queue, Pub/Sub, Cron, Webhook, WebSocket, SSE), 4 examples",
		createdAt: "2026-01-28T00:00:00Z",
		contentHash: "",
	},
	"create-trigger": {
		id: "create-trigger",
		version: "2.0.0",
		changelog: "TriggerBase architecture, 6 trigger type examples, context creation pattern",
		createdAt: "2026-01-28T00:00:00Z",
		contentHash: "",
	},
	"create-runtime": {
		id: "create-runtime",
		version: "1.0.0",
		changelog: "Runtime SDK generation for Go, Java, Rust, Python, C#, PHP, Ruby with HTTP protocol",
		createdAt: "2026-01-28T00:00:00Z",
		contentHash: "",
	},
};

/**
 * Compute a simple hash of prompt content for integrity tracking
 */
export function computeContentHash(content: string): string {
	let hash = 0;
	for (let i = 0; i < content.length; i++) {
		const char = content.charCodeAt(i);
		hash = ((hash << 5) - hash + char) | 0;
	}
	return Math.abs(hash).toString(36);
}

/**
 * Get the version info for a specific prompt
 */
export function getPromptVersion(promptId: string): PromptVersion | undefined {
	return PROMPT_VERSIONS[promptId];
}

/**
 * Get all registered prompt versions
 */
export function getAllPromptVersions(): PromptVersion[] {
	return Object.values(PROMPT_VERSIONS);
}

/**
 * Generate a version stamp string for embedding in generation metadata
 */
export function getVersionStamp(promptId: string): string {
	const version = PROMPT_VERSIONS[promptId];
	if (!version) return `${promptId}@unknown`;
	return `${version.id}@${version.version}`;
}

/**
 * Register prompt content and compute its hash
 */
export function registerPromptContent(promptId: string, content: string): void {
	const version = PROMPT_VERSIONS[promptId];
	if (version) {
		version.contentHash = computeContentHash(content);
	}
}

export default {
	PROMPT_VERSIONS,
	getPromptVersion,
	getAllPromptVersions,
	getVersionStamp,
	computeContentHash,
	registerPromptContent,
};
