import type {
	CapabilityAuthority,
	CapabilityAuthorizationPort,
	CapabilityEffect,
	CapabilityManifestV1,
	PolicyContext,
	SessionJsonValue,
} from "@blokjs/shared";
import type { z } from "zod";

export const CODE_MODE_CONTRACT_VERSION = "1" as const;
export const CODE_MODE_MAX_SOURCE_BYTES = 64 * 1024;
export const CODE_MODE_MAX_INPUT_BYTES = 256 * 1024;
export const CODE_MODE_MAX_OUTPUT_BYTES = 256 * 1024;
export const CODE_MODE_MAX_MEMORY_BYTES = 256 * 1024 * 1024;
export const CODE_MODE_MIN_MEMORY_BYTES = 8 * 1024 * 1024;
export const CODE_MODE_DEFAULT_WALL_TIME_MS = 5_000;
export const CODE_MODE_MAX_WALL_TIME_MS = 30_000;
export const CODE_MODE_DEFAULT_MEMORY_BYTES = 32 * 1024 * 1024;
export const CODE_MODE_DEFAULT_MAX_CALLS = 32;
export const CODE_MODE_MAX_CALLS = 128;
export const CODE_MODE_DEFAULT_MAX_NESTING = 4;
export const CODE_MODE_MAX_NESTING = 16;
export const CODE_MODE_DEFAULT_MAX_PARALLELISM = 4;
export const CODE_MODE_MAX_PARALLELISM = 16;
export const CODE_MODE_CLEANUP_TIMEOUT_MS = 250;
export const CODE_MODE_MAX_LOG_ENTRIES = 256;

export type CodeModeBudgets = {
	readonly maxWallTimeMs?: number;
	readonly maxMemoryBytes?: number;
	readonly maxOutputBytes?: number;
	readonly maxCalls?: number;
	readonly maxNesting?: number;
	readonly maxParallelism?: number;
};

export type CodeModeLogEntry = {
	readonly value: SessionJsonValue;
};

export type CodeModeBindingCallContext = {
	readonly callId: string;
	readonly depth: number;
	readonly signal: AbortSignal;
	/** Nested calls use this same policy-gated path and cannot widen authority. */
	readonly call: (name: string, input: SessionJsonValue) => Promise<SessionJsonValue>;
};

export type CodeModeBinding<Input = unknown, Output = unknown> = {
	/** Must be a valid JavaScript identifier so generated bindings stay dot-addressable. */
	readonly name: string;
	readonly description?: string;
	readonly input: z.ZodType<Input>;
	readonly output: z.ZodType<Output>;
	readonly manifest: CapabilityManifestV1;
	readonly authority: CapabilityAuthority;
	readonly invoke: (input: Input, context: CodeModeBindingCallContext) => Promise<Output> | Output;
};

export type CodeModePolicy = {
	/** The existing runner/capability authorization seam; this package never decides policy. */
	readonly authorization: CapabilityAuthorizationPort;
	/** Expected policy version; a decision from another policy snapshot fails closed. */
	readonly policyVersion: string;
	/** Base identity, workflow, phase, and parent authority for this execution. */
	readonly context: PolicyContext;
};

export type CodeModeExecutionOptions = {
	readonly source: string;
	readonly input?: SessionJsonValue;
	readonly bindings?: readonly CodeModeBinding[];
	readonly policy?: CodeModePolicy;
	readonly budgets?: CodeModeBudgets;
	readonly signal?: AbortSignal;
	readonly filename?: string;
};

export type CodeModeExecutionResult = {
	readonly contractVersion: typeof CODE_MODE_CONTRACT_VERSION;
	readonly output: SessionJsonValue;
	readonly logs: readonly CodeModeLogEntry[];
	readonly emissions: readonly SessionJsonValue[];
	readonly calls: number;
	readonly peakParallelism: number;
	readonly outputBytes: number;
};

export type CodeModeValidationIssue = {
	readonly message: string;
	readonly line: number;
	readonly column: number;
};

export type CodeModeValidationResult = {
	readonly valid: boolean;
	readonly sourceBytes: number;
	readonly issues: readonly CodeModeValidationIssue[];
	readonly transpiledSource?: string;
};

export type CodeModeValidationOptions = {
	readonly maxSourceBytes?: number;
};

export type CodeModeEffect = CapabilityEffect;
