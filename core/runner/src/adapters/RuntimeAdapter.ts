import type { Context } from "@blokjs/shared";
import type RunnerNode from "../RunnerNode";

/**
 * RuntimeKind represents all supported runtime environments
 */
export type RuntimeKind =
	| "nodejs"
	| "bun"
	| "python3"
	| "go"
	| "java"
	| "rust"
	| "php"
	| "csharp"
	| "ruby"
	| "docker"
	| "wasm";

/**
 * Wire transport an adapter uses to reach an SDK runtime. `module` is for
 * in-process NodeJS adapters; `http` and `grpc` are the two non-NodeJS
 * options. Used for log tagging and for distinguishing the same `kind`
 * across transports during the gRPC migration.
 */
export type AdapterTransport = "module" | "http" | "grpc";

/**
 * ExecutionResult is the canonical response structure from any runtime adapter
 */
export type ExecutionResult = {
	success: boolean;
	data: unknown;
	/**
	 * The node's intended response Content-Type, sourced from the proto
	 * `content_type` field the SDK populates (default `"application/json"`).
	 * It travels ALONGSIDE `data`, never inside it — the trigger maps it to
	 * the HTTP `Content-Type` header. Omitted by in-process adapters that
	 * don't carry a wire content-type.
	 */
	contentType?: string;
	errors: unknown | null;
	logs?: string[];
	metrics?: {
		duration_ms?: number;
		cpu_ms?: number;
		memory_bytes?: number;
		/** Approximate or exact bytes the adapter sent on the wire. */
		request_bytes?: number;
		/** Bytes the adapter received from the SDK. */
		response_bytes?: number;
	};
	/** Variables set by the SDK node during execution, to be merged into ctx.vars */
	vars?: Record<string, unknown>;
};

/**
 * RuntimeAdapter is the core abstraction for executing nodes in different language runtimes
 *
 * All runtime adapters (NodeJS, Python, Go, Java, etc.) implement this interface
 * to provide a uniform execution contract for the workflow orchestrator.
 */
export interface RuntimeAdapter {
	/**
	 * The kind of runtime this adapter handles
	 */
	readonly kind: RuntimeKind;

	/**
	 * Wire transport this adapter uses (`http`, `grpc`, or in-process
	 * `module`). Surfaced in step-prefix logs so operators can tell at a
	 * glance which path a runtime node took during the migration.
	 */
	readonly transport: AdapterTransport;

	/**
	 * Execute a node in this runtime
	 *
	 * @param node - The node to execute (includes node path, name, config)
	 * @param ctx - The workflow execution context
	 * @returns Promise that resolves to ExecutionResult
	 */
	execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult>;

	/**
	 * v0.7 — enumerate the nodes this runtime exposes, for the node catalog
	 * (`GET /__blok/nodes`) + `blokctl nodes list`. Optional: only adapters that
	 * can reflect their registry implement it (the gRPC adapter via the
	 * `ListNodes` RPC). In-process module nodes are enumerated from the node map
	 * by the catalog directly. Schemas are populated per-SDK (SPEC-B P2/P3);
	 * until then `inputSchema`/`outputSchema` are `null`.
	 */
	listNodes?(): Promise<RuntimeNodeDescriptor[]>;
}

/** One node as reported by a runtime's reflection (gRPC `ListNodes`). */
export interface RuntimeNodeDescriptor {
	name: string;
	description?: string;
	/** JSON Schema (parsed) for the node's input, or `null` if the SDK didn't emit one yet. */
	inputSchema: unknown | null;
	/** JSON Schema (parsed) for the node's output, or `null`. */
	outputSchema: unknown | null;
	tags?: string[];
}
