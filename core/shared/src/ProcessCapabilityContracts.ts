import { z } from "zod";
import {
	AGENT_CAPABILITY_CONTRACT_VERSION,
	CAPABILITY_MAX_ID_LENGTH,
	CAPABILITY_MAX_LIST_ITEMS,
	CAPABILITY_MAX_OUTPUT_CHUNK_BYTES,
	CapabilityContractError,
	CapabilityOwnerSchema,
	WorkspacePathRefSchema,
	assertAuthorized,
	assertOwned,
	capabilityScope,
	identifier,
	parseCapabilityOwner,
	timestamp,
} from "./CapabilityContracts";
import type { CapabilityOwner, CapabilityRequestContext, WorkspacePathRef } from "./CapabilityContracts";
import type { CapabilityEffect } from "./CapabilityManifest";
import type { PolicyEvaluationResult, PolicyRequest } from "./PolicyContracts";

export const PROCESS_CAPABILITY_CONTRACT_VERSION = AGENT_CAPABILITY_CONTRACT_VERSION;
export const PROCESS_DEFAULT_LIMITS = {
	maxWallTimeMs: 120_000,
	maxCpuTimeMs: 60_000,
	maxMemoryBytes: 512 * 1024 * 1024,
	maxOutputBytes: 4 * 1024 * 1024,
	maxInputBytes: 1 * 1024 * 1024,
	maxProcesses: 1,
} as const;

export const PROCESS_CAPABILITY_IDS = ["process.exec", "process.pty", "shell.exec"] as const;
export type ProcessCapabilityId = (typeof PROCESS_CAPABILITY_IDS)[number];
export type ProcessLifecycleStatus =
	| "starting"
	| "running"
	| "exited"
	| "failed"
	| "cancelled"
	| "orphaned"
	| "cleaned";

export interface ProcessEnvironmentBinding {
	readonly name: string;
	readonly source: "host" | "secret";
	/** Host environment variable name or opaque SecretRef name; never a value. */
	readonly reference: string;
}

export interface NetworkDestination {
	readonly protocol: "tcp" | "udp";
	readonly host: string;
	readonly port: number;
}

export type ProcessNetworkPolicy =
	| { readonly mode: "none" }
	| { readonly mode: "allowlist"; readonly destinations: readonly NetworkDestination[] };

export interface ProcessResourceLimits {
	readonly maxWallTimeMs: number;
	readonly maxCpuTimeMs: number;
	readonly maxMemoryBytes: number;
	readonly maxOutputBytes: number;
	readonly maxInputBytes: number;
	readonly maxProcesses: number;
}

export interface ProcessSpecBase {
	readonly version: typeof PROCESS_CAPABILITY_CONTRACT_VERSION;
	readonly cwd: WorkspacePathRef;
	readonly env: readonly ProcessEnvironmentBinding[];
	readonly stdin: "closed" | "provided";
	readonly terminal: "pipe" | "pty";
	readonly limits: ProcessResourceLimits;
	readonly network: ProcessNetworkPolicy;
	readonly background: "foreground" | "durable";
}

/** Structured execution. Providers must pass executable/args to spawn with shell disabled. */
export interface ExecutableProcessSpec extends ProcessSpecBase {
	readonly mode: "executable";
	readonly executable: string;
	readonly args: readonly string[];
}

/** Shell parsing is an explicit, separately policy-classified capability. */
export interface ShellStringProcessSpec extends ProcessSpecBase {
	readonly mode: "shell-string";
	readonly shell: string;
	readonly command: string;
}

export type ProcessSpec = ExecutableProcessSpec | ShellStringProcessSpec;

export interface ProcessStartRequest extends CapabilityRequestContext {
	readonly policy: PolicyRequest;
	readonly spec: ProcessSpec;
	readonly owner: CapabilityOwner;
}

export type ProcessStartResult =
	| { readonly kind: "started"; readonly handle: ProcessHandle }
	| { readonly kind: "completed"; readonly result: ProcessResult };

export interface ProcessHandle {
	readonly version: typeof PROCESS_CAPABILITY_CONTRACT_VERSION;
	readonly id: string;
	readonly owner: CapabilityOwner;
	readonly specDigest: string;
	readonly status: ProcessLifecycleStatus;
	readonly startedAt: string;
	readonly updatedAt: string;
	readonly pid?: number;
	readonly terminal: "pipe" | "pty";
	readonly background: "foreground" | "durable";
	readonly outputBytes: number;
	readonly outputTruncated: boolean;
}

export interface ProcessOutputChunk {
	readonly stream: "stdout" | "stderr";
	readonly sequence: number;
	readonly data: string;
	readonly byteLength: number;
}

export interface ProcessOutputSnapshot {
	readonly stdout: string;
	readonly stderr: string;
	readonly capturedBytes: number;
	readonly totalBytes: number;
	readonly truncated: boolean;
}

export interface ProcessResult {
	readonly handle: ProcessHandle;
	readonly status: "exited" | "failed" | "cancelled";
	readonly exitCode?: number;
	readonly signal?: string;
	readonly output: ProcessOutputSnapshot;
	readonly durationMs: number;
}

export interface ProcessHandleRequest extends CapabilityRequestContext {
	readonly policy: PolicyRequest;
	readonly handle: ProcessHandle;
}

export interface ProcessCancellationRequest extends ProcessHandleRequest {
	readonly reason: "user" | "timeout" | "policy" | "session-closed" | "orphan-cleanup";
	readonly gracePeriodMs: number;
}

export interface ProcessOrphanCleanupRequest extends CapabilityRequestContext {
	readonly policy: PolicyRequest;
	readonly owner: CapabilityOwner;
	readonly olderThan: string;
}

export interface ProcessCapability {
	/** Durable/background starts return a handle; foreground starts may complete inline. */
	start(request: ProcessStartRequest): Promise<ProcessStartResult>;
	inspect(request: ProcessHandleRequest): Promise<ProcessHandle>;
	readOutput(request: ProcessHandleRequest): AsyncIterable<ProcessOutputChunk>;
	cancel(request: ProcessCancellationRequest): Promise<ProcessHandle>;
	cleanupOrphans(request: ProcessOrphanCleanupRequest): Promise<readonly ProcessHandle[]>;
}

const envName = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const envBindingSchema = z.object({ name: envName, source: z.enum(["host", "secret"]), reference: identifier });
const networkSchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("none") }),
	z.object({
		mode: z.literal("allowlist"),
		destinations: z
			.array(
				z.object({
					protocol: z.enum(["tcp", "udp"]),
					host: z
						.string()
						.min(1)
						.max(253)
						.regex(/^[A-Za-z0-9.-]+$/),
					port: z.number().int().min(1).max(65_535),
				}),
			)
			.min(1)
			.max(128),
	}),
]);
const limitsSchema = z.object({
	maxWallTimeMs: z.number().int().positive().max(86_400_000).default(PROCESS_DEFAULT_LIMITS.maxWallTimeMs),
	maxCpuTimeMs: z.number().int().positive().max(86_400_000).default(PROCESS_DEFAULT_LIMITS.maxCpuTimeMs),
	maxMemoryBytes: z
		.number()
		.int()
		.positive()
		.max(8 * 1024 * 1024 * 1024)
		.default(PROCESS_DEFAULT_LIMITS.maxMemoryBytes),
	maxOutputBytes: z
		.number()
		.int()
		.positive()
		.max(256 * 1024 * 1024)
		.default(PROCESS_DEFAULT_LIMITS.maxOutputBytes),
	maxInputBytes: z
		.number()
		.int()
		.positive()
		.max(256 * 1024 * 1024)
		.default(PROCESS_DEFAULT_LIMITS.maxInputBytes),
	maxProcesses: z.number().int().positive().max(256).default(PROCESS_DEFAULT_LIMITS.maxProcesses),
});
const baseSchema = z.object({
	version: z.literal(PROCESS_CAPABILITY_CONTRACT_VERSION),
	cwd: WorkspacePathRefSchema,
	env: z.array(envBindingSchema).max(CAPABILITY_MAX_LIST_ITEMS).default([]),
	stdin: z.enum(["closed", "provided"]).default("closed"),
	terminal: z.enum(["pipe", "pty"]).default("pipe"),
	limits: limitsSchema.default(PROCESS_DEFAULT_LIMITS),
	network: networkSchema.default({ mode: "none" }),
	background: z.enum(["foreground", "durable"]).default("foreground"),
});
const executableSchema = baseSchema.extend({
	mode: z.literal("executable"),
	executable: z
		.string()
		.min(1)
		.max(CAPABILITY_MAX_ID_LENGTH)
		.regex(/^[^\s\0;&|<>`$]+$/),
	args: z
		.array(
			z
				.string()
				.max(16_384)
				.refine((value) => !value.includes("\0"), "must not contain NUL"),
		)
		.max(CAPABILITY_MAX_LIST_ITEMS),
});
const shellSchema = baseSchema.extend({
	mode: z.literal("shell-string"),
	shell: z
		.string()
		.min(1)
		.max(CAPABILITY_MAX_ID_LENGTH)
		.regex(/^[^\s\0;&|<>`$]+$/),
	command: z
		.string()
		.min(1)
		.max(256 * 1024)
		.refine((value) => !value.includes("\0"), "must not contain NUL"),
});
const processSchema = z.discriminatedUnion("mode", [executableSchema, shellSchema]);
const digestSchema = z
	.string()
	.regex(/^(?:sha256):[0-9a-f]{64}$|^(?:sha512):[0-9a-f]{128}$/i)
	.transform((value) => value.toLowerCase());
const handleSchema = z.object({
	version: z.literal(PROCESS_CAPABILITY_CONTRACT_VERSION),
	id: identifier,
	owner: CapabilityOwnerSchema,
	specDigest: digestSchema,
	status: z.enum(["starting", "running", "exited", "failed", "cancelled", "orphaned", "cleaned"]),
	startedAt: timestamp,
	updatedAt: timestamp,
	pid: z.number().int().positive().max(4_194_304).optional(),
	terminal: z.enum(["pipe", "pty"]),
	background: z.enum(["foreground", "durable"]),
	outputBytes: z
		.number()
		.int()
		.nonnegative()
		.max(256 * 1024 * 1024),
	outputTruncated: z.boolean(),
});
const outputSchema = z.object({
	stdout: z.string(),
	stderr: z.string(),
	capturedBytes: z
		.number()
		.int()
		.nonnegative()
		.max(256 * 1024 * 1024),
	totalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	truncated: z.boolean(),
});
const resultSchema = z
	.object({
		handle: handleSchema,
		status: z.enum(["exited", "failed", "cancelled"]),
		exitCode: z.number().int().min(-255).max(255).optional(),
		signal: identifier.optional(),
		output: outputSchema,
		durationMs: z.number().int().nonnegative().max(86_400_000),
	})
	.superRefine((value, context) => {
		if (value.handle.status !== value.status)
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["handle", "status"],
				message: "must match result status",
			});
	});
const chunkSchema = z.object({
	stream: z.enum(["stdout", "stderr"]),
	sequence: z.number().int().nonnegative(),
	data: z.string(),
	byteLength: z.number().int().nonnegative().max(CAPABILITY_MAX_OUTPUT_CHUNK_BYTES),
});

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown, label: string): z.output<T> {
	const result = schema.safeParse(value);
	if (!result.success)
		throw new CapabilityContractError(`${label}: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
	return result.data;
}
function immutable<T>(value: T): T {
	const snapshot = structuredClone(value);
	const freeze = (item: unknown): void => {
		if (item === null || typeof item !== "object" || Object.isFrozen(item)) return;
		for (const child of Object.values(item)) freeze(child);
		Object.freeze(item);
	};
	freeze(snapshot);
	return snapshot;
}

export function parseProcessSpec(value: unknown): ProcessSpec {
	const spec = parse(processSchema, value, "process spec");
	const names = new Set<string>();
	for (const binding of spec.env) {
		if (names.has(binding.name))
			throw new CapabilityContractError(`process spec: duplicate environment name ${binding.name}`);
		names.add(binding.name);
		if (binding.source === "host" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.reference))
			throw new CapabilityContractError(`process spec: host environment reference ${binding.reference} is invalid`);
	}
	return immutable(spec);
}
export function parseProcessHandle(value: unknown): ProcessHandle {
	return immutable(parse(handleSchema, value, "process handle"));
}
export function parseProcessOutput(value: unknown): ProcessOutputSnapshot {
	const output = parse(outputSchema, value, "process output");
	const capturedBytes = new TextEncoder().encode(`${output.stdout}${output.stderr}`).byteLength;
	if (capturedBytes !== output.capturedBytes)
		throw new CapabilityContractError("process output capturedBytes is incorrect");
	if (output.capturedBytes > output.totalBytes)
		throw new CapabilityContractError("process output capturedBytes exceeds totalBytes");
	return immutable(output);
}
export function parseProcessResult(value: unknown): ProcessResult {
	const result = parse(resultSchema, value, "process result");
	const output = parseProcessOutput(result.output);
	return immutable({ ...result, output });
}
export function parseProcessOutputChunk(value: unknown): ProcessOutputChunk {
	const chunk = parse(chunkSchema, value, "process output chunk");
	const byteLength = new TextEncoder().encode(chunk.data).byteLength;
	if (byteLength !== chunk.byteLength)
		throw new CapabilityContractError("process output chunk byteLength is incorrect");
	return immutable(chunk);
}
export function parseProcessCancellationRequest(value: unknown): ProcessCancellationRequest {
	const schema = z.object({
		policy: z.custom<PolicyRequest>(),
		owner: CapabilityOwnerSchema,
		handle: handleSchema,
		reason: z.enum(["user", "timeout", "policy", "session-closed", "orphan-cleanup"]),
		gracePeriodMs: z.number().int().nonnegative().max(60_000),
	});
	return immutable(parse(schema, value, "process cancellation request"));
}

export function parseProcessOrphanCleanupRequest(value: unknown): ProcessOrphanCleanupRequest {
	const schema = z.object({
		policy: z.custom<PolicyRequest>(),
		owner: CapabilityOwnerSchema,
		olderThan: timestamp,
	});
	return immutable(parse(schema, value, "process orphan cleanup request"));
}

export function processCapabilityId(spec: ProcessSpec): ProcessCapabilityId {
	if (spec.mode === "shell-string") return "shell.exec";
	return spec.terminal === "pty" ? "process.pty" : "process.exec";
}

export function processCapabilityScope(spec: ProcessSpec): ReturnType<typeof capabilityScope> {
	const effects = ["process"] as const;
	const capabilities = [processCapabilityId(spec)];
	const secrets = spec.env.filter((binding) => binding.source === "secret").map((binding) => binding.reference);
	const withTerminal: CapabilityEffect[] = spec.terminal === "pty" ? [...effects, "streaming"] : [...effects];
	if (spec.network.mode === "allowlist") return capabilityScope([...withTerminal, "network"], capabilities, secrets);
	return capabilityScope(withTerminal, capabilities, secrets);
}

export function assertProcessPolicyAllowed(spec: ProcessSpec, result: PolicyEvaluationResult): void {
	if (spec.mode === "shell-string" && result.decision.kind !== "allow")
		throw new CapabilityContractError(`shell-string execution requires explicit allow policy: ${result.decision.kind}`);
	if (spec.mode === "shell-string" && result.decision.kind === "require-sandbox")
		throw new CapabilityContractError("shell-string execution requires an explicit allow decision");
	assertAuthorized(result, { allowSandbox: true });
}

export function assertProcessOwner(handle: ProcessHandle, owner: CapabilityOwner): void {
	assertOwned(handle.owner, parseCapabilityOwner(owner));
}

export function assertBoundedOutputChunk(value: ProcessOutputChunk): void {
	if (new TextEncoder().encode(value.data).byteLength > CAPABILITY_MAX_OUTPUT_CHUNK_BYTES)
		throw new CapabilityContractError("process output chunk exceeds the hard byte bound");
}

export function processWorkspaceCwd(spec: ProcessSpec): WorkspacePathRef {
	return spec.cwd;
}

/** A durable run must remain addressable; a foreground run must be complete. */
export function assertProcessStartResult(spec: ProcessSpec, result: ProcessStartResult): void {
	if (spec.background === "durable" && result.kind !== "started")
		throw new CapabilityContractError("durable process execution must return a background handle");
	if (spec.background === "foreground" && result.kind !== "completed")
		throw new CapabilityContractError("foreground process execution must complete inline");
}
