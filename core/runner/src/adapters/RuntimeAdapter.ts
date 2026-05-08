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
}
