import { z } from "zod";
import {
	CAPABILITY_CLASSIFICATIONS,
	CAPABILITY_DETERMINISM,
	CAPABILITY_EFFECTS,
	CAPABILITY_IDEMPOTENCY,
	CAPABILITY_MANIFEST_VERSION,
	CAPABILITY_MATURITY,
	type CapabilityManifestV1,
	parseCapabilityManifest,
} from "./CapabilityManifest";

/** The version of the Blok-owned component manifest, independent of WASI. */
export const WASI_COMPONENT_MANIFEST_VERSION = "1" as const;
/** The version of the runner↔host request/response seam. */
export const WASI_COMPONENT_CONTRACT_VERSION = "1" as const;
export const WASI_COMPONENT_WIT_PACKAGE = "blok:runtime" as const;
export const WASI_COMPONENT_WIT_WORLD = "blok-node" as const;
export const WASI_COMPONENT_WIT_VERSION = "1.0.0" as const;
/** v1 targets the stable WASI 0.2 Component Model surface. */
export const WASI_COMPONENT_WASI_VERSION = "0.2" as const;
export const WASI_COMPONENT_MEDIA_TYPE = "application/wasm-component" as const;

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

const CapabilityManifestSchema = z
	.object({
		version: z.literal(CAPABILITY_MANIFEST_VERSION),
		classification: z.enum(CAPABILITY_CLASSIFICATIONS),
		effects: z.array(z.enum(CAPABILITY_EFFECTS)),
		capabilities: z.array(z.string()),
		secrets: z.array(z.string()),
		determinism: z.enum(CAPABILITY_DETERMINISM),
		idempotency: z.enum(CAPABILITY_IDEMPOTENCY),
		maturity: z.enum(CAPABILITY_MATURITY),
		resources: z
			.object({
				maxDurationMs: z.number().int().positive().optional(),
				maxMemoryBytes: z.number().int().positive().optional(),
				maxInputBytes: z.number().int().positive().optional(),
				maxOutputBytes: z.number().int().positive().optional(),
				maxConcurrency: z.number().int().positive().optional(),
			})
			.strict()
			.optional(),
		runtimes: z.array(z.string()).optional(),
		triggers: z.array(z.string()).optional(),
	})
	.strict();

export const WasiComponentLimitsSchema = z
	.object({
		/** Deterministic compute budget. The host must translate this to fuel. */
		fuel: z.number().int().positive().optional(),
		/** Wall-clock guard used with epoch interruption, not as a fuel substitute. */
		maxDurationMs: z.number().int().positive().optional(),
		maxMemoryBytes: z.number().int().positive().optional(),
		maxInputBytes: z.number().int().positive().optional(),
		maxOutputBytes: z.number().int().positive().optional(),
		maxLogBytes: z.number().int().positive().optional(),
		maxHostCalls: z.number().int().positive().optional(),
		maxConcurrentExecutions: z.number().int().positive().optional(),
		maxQueueDepth: z.number().int().positive().optional(),
	})
	.strict()
	.optional();

export const WasiComponentArtifactSchema = z
	.object({
		/** Development may use a local path; production policy still requires digest. */
		uri: z.string().min(1).max(2048),
		digest: z.string().regex(SHA256_DIGEST, "artifact.digest must be a lowercase sha256 digest"),
		mediaType: z.literal(WASI_COMPONENT_MEDIA_TYPE),
		sizeBytes: z.number().int().positive().optional(),
	})
	.strict();

export const WasiComponentWorldSchema = z
	.object({
		package: z.literal(WASI_COMPONENT_WIT_PACKAGE),
		world: z.literal(WASI_COMPONENT_WIT_WORLD),
		version: z.string().regex(SEMVER, "world.version must be semantic versioning"),
	})
	.strict();

export const WasiComponentNodeSchema = z
	.object({
		name: z.string().regex(IDENTIFIER),
		description: z.string().max(4096).optional(),
		tags: z.array(z.string().regex(IDENTIFIER)).max(64).optional(),
		inputSchema: z.unknown().optional(),
		outputSchema: z.unknown().optional(),
	})
	.strict();

export const WasiComponentManifestSchema = z
	.object({
		version: z.literal(WASI_COMPONENT_MANIFEST_VERSION),
		runtime: z.literal("runtime.wasi"),
		artifact: WasiComponentArtifactSchema,
		world: WasiComponentWorldSchema,
		wasiVersion: z.literal(WASI_COMPONENT_WASI_VERSION),
		componentModelVersion: z.literal(WASI_COMPONENT_WASI_VERSION),
		exportName: z.string().regex(IDENTIFIER),
		node: WasiComponentNodeSchema,
		capabilityManifest: CapabilityManifestSchema,
		limits: WasiComponentLimitsSchema,
	})
	.strict();

export type WasiComponentLimits = z.infer<typeof WasiComponentLimitsSchema>;
export type WasiComponentArtifact = z.infer<typeof WasiComponentArtifactSchema>;
export type WasiComponentWorld = z.infer<typeof WasiComponentWorldSchema>;
export type WasiComponentNode = z.infer<typeof WasiComponentNodeSchema>;
export type WasiComponentManifestV1 = Omit<z.infer<typeof WasiComponentManifestSchema>, "capabilityManifest"> & {
	capabilityManifest: CapabilityManifestV1;
};

/** Parse and normalize the only manifest accepted by the v1 WASI seam. */
export function parseWasiComponentManifest(value: unknown): WasiComponentManifestV1 {
	const parsed = WasiComponentManifestSchema.parse(value);
	return {
		...parsed,
		capabilityManifest: parseCapabilityManifest(parsed.capabilityManifest),
	};
}

export function serializeWasiComponentManifest(value: unknown): string {
	return JSON.stringify(parseWasiComponentManifest(value));
}

export const WasiComponentErrorSchema = z
	.object({
		code: z.string().regex(ERROR_CODE),
		category: z.enum([
			"VALIDATION",
			"CONFIGURATION",
			"DEPENDENCY",
			"TIMEOUT",
			"PERMISSION",
			"RATE_LIMIT",
			"NOT_FOUND",
			"CONFLICT",
			"CANCELLED",
			"INTERNAL",
			"PROTOCOL",
			"DATA",
		]),
		message: z.string().min(1).max(1024),
		retryable: z.boolean(),
		details: z.record(z.unknown()).optional(),
	})
	.strict();

export const WasiComponentExecutionRequestSchema = z
	.object({
		contractVersion: z.literal(WASI_COMPONENT_CONTRACT_VERSION),
		componentDigest: z.string().regex(SHA256_DIGEST),
		exportName: z.string().regex(IDENTIFIER),
		input: z.unknown(),
		request: z.object({
			body: z.unknown(),
			headers: z.record(z.string()),
			params: z.record(z.string()),
			query: z.record(z.string()),
		}),
		contentType: z.string().min(1).max(256),
		deadlineMs: z.number().int().positive(),
		traceparent: z.string().max(512).optional(),
	})
	.strict();

export const WasiComponentExecutionResponseSchema = z
	.object({
		contractVersion: z.literal(WASI_COMPONENT_CONTRACT_VERSION),
		success: z.boolean(),
		output: z.unknown().nullable(),
		contentType: z.string().min(1).max(256).optional(),
		logs: z
			.array(
				z
					.object({
						level: z.enum(["debug", "info", "warn", "error"]),
						message: z.string().max(8192),
					})
					.strict(),
			)
			.max(1024),
		metrics: z
			.object({
				durationMs: z.number().nonnegative().optional(),
				cpuMs: z.number().nonnegative().optional(),
				memoryBytes: z.number().int().nonnegative().optional(),
			})
			.strict()
			.optional(),
		error: WasiComponentErrorSchema.optional(),
	})
	.strict()
	.refine((value) => value.success === (value.error === undefined), {
		message: "success and error must agree",
		path: ["error"],
	});

export type WasiComponentExecutionRequest = z.infer<typeof WasiComponentExecutionRequestSchema>;
export type WasiComponentExecutionResponse = z.infer<typeof WasiComponentExecutionResponseSchema>;

/** The boundary intentionally carries only these host-mediated capabilities in v1. */
export const WASI_COMPONENT_CAPABILITIES = [
	"wasi.log",
	"wasi.trace",
	"wasi.secret.read",
	"wasi.blob.read",
	"wasi.fs.read",
	"wasi.fs.write",
	"wasi.net.connect",
	"wasi.env.read",
	"wasi.clock.read",
	"wasi.random.read",
	"wasi.http.request",
	"wasi.socket.connect",
	"wasi.process.spawn",
	"wasi.state.read",
	"wasi.state.write",
] as const;

export type WasiComponentReadiness = {
	status: "ready" | "draining" | "unavailable";
	contractVersion: typeof WASI_COMPONENT_CONTRACT_VERSION;
	engineVersion?: string;
	reason?: string;
};
