import type { Context } from "@nanoservice-ts/shared";
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
	};
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
	 * Execute a node in this runtime
	 *
	 * @param node - The node to execute (includes node path, name, config)
	 * @param ctx - The workflow execution context
	 * @returns Promise that resolves to ExecutionResult
	 */
	execute(node: RunnerNode, ctx: Context): Promise<ExecutionResult>;
}
