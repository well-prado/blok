import {
	CAPABILITY_CLASSIFICATIONS,
	CAPABILITY_DETERMINISM,
	CAPABILITY_EFFECTS,
	CAPABILITY_IDEMPOTENCY,
	CAPABILITY_MANIFEST_VERSION,
	CAPABILITY_MATURITY,
	type CapabilityManifestV1,
	parseCapabilityManifest,
} from "@blokjs/shared";
import { z } from "zod";
import { StepInputsSchema, StepOptsSchema, V2StepSchema } from "./StepOpts";
import { TriggersSchema } from "./TriggerOpts";

const CapabilityIdentifierSchema = z
	.string()
	.regex(/^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/, "must be an opaque capability or secret reference name");

const CapabilityManifestSchema = z
	.object({
		version: z.literal(CAPABILITY_MANIFEST_VERSION),
		classification: z.enum(CAPABILITY_CLASSIFICATIONS),
		effects: z.array(z.enum(CAPABILITY_EFFECTS)),
		capabilities: z.array(CapabilityIdentifierSchema),
		secrets: z.array(CapabilityIdentifierSchema),
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
			.passthrough()
			.optional(),
		runtimes: z.array(CapabilityIdentifierSchema).optional(),
		triggers: z.array(CapabilityIdentifierSchema).optional(),
	})
	.passthrough()
	.transform((value): CapabilityManifestV1 => parseCapabilityManifest(value));

/**
 * Validation schema for the workflow envelope (v1 — legacy).
 *
 * Note: `trigger` is intentionally permissive (`unknown` value) at this layer
 * because per-kind validation lives in {@link Trigger.addTrigger} via
 * `validateTriggerConfig`. Tightening it here would force the legacy HTTP
 * shape onto every trigger kind.
 *
 * @deprecated Prefer {@link WorkflowV2Schema}. v1 shapes are still accepted
 * and normalized at workflow load time.
 */
export const WorkflowOptsSchema = z.object({
	name: z
		.string({
			required_error: "Name is required",
			invalid_type_error: "Name must be a string",
		})
		.min(3),
	version: z
		.string({
			required_error: "Version is required",
			invalid_type_error: "Version must be a string",
		})
		.min(5, { message: "Format required x.x.x" }),
	description: z.string().optional(),
	capabilityManifest: CapabilityManifestSchema.optional(),
	steps: z.array(StepOptsSchema).optional(),
	nodes: z.record(z.string(), StepInputsSchema).optional(),
	trigger: z.record(TriggersSchema, z.unknown()).optional(),
});

export type WorkflowOpts = z.infer<typeof WorkflowOptsSchema>;

// =============================================================================
// V2 — Canonical workflow shape.
// =============================================================================

/**
 * Validation schema for the v2 workflow envelope.
 *
 * Differences from v1:
 * - No top-level `nodes{}` map — `inputs` lives directly on each step.
 * - `steps[]` is required and contains v2 step shapes (id + use + inputs)
 *   OR branch shapes ({ id, branch: { when, then, else } }).
 * - `trigger` is required (workflows must have at least one trigger).
 *
 * Backward compatibility: v1 workflows are converted to v2 at workflow load
 * time by the runner's WorkflowNormalizer.
 *
 * @example
 *   {
 *     name: "World Countries",
 *     version: "1.0.0",
 *     trigger: { http: { method: "GET" } },
 *     steps: [
 *       { id: "fetch", use: "@blokjs/api-call", inputs: { url: "..." } }
 *     ]
 *   }
 */
export const WorkflowV2Schema = z.object({
	schemaVersion: z
		.literal("2")
		.default("2")
		.describe("Workflow IR schema version. Defaults to '2'; future versions must be rejected explicitly."),
	name: z.string().min(3).describe("Workflow display name. Min 3 characters. Shown in Studio."),
	version: z
		.string()
		.min(5, { message: "Format required x.x.x" })
		.describe("Semantic version (x.x.x). Used for trace recording and audit."),
	description: z
		.string()
		.optional()
		.describe("What this workflow does. Optional but recommended — surfaces in Studio and CLI."),
	capabilityManifest: CapabilityManifestSchema.optional().describe(
		"Versioned operational effects, required capabilities, secret reference names, reliability classes, and resource bounds.",
	),
	trigger: z
		.record(TriggersSchema, z.unknown())
		.optional()
		.describe(
			"Trigger configuration. Most workflows use { http: { method: 'GET' } }. " +
				"Optional ONLY when `middleware: true` is set — middleware-only workflows " +
				"are invoked from another workflow's `trigger.http.middleware: [...]` array " +
				"and don't have a public route of their own. See TRIGGER_SCHEMAS for per-kind shapes.",
		),
	middleware: z
		.union([z.literal(true), z.array(z.string().min(1))])
		.optional()
		.describe(
			"Overloaded by design — the value's TYPE picks the meaning, and the two are mutually " +
				"exclusive (setting both is impossible on one key; the normalizer throws if a builder " +
				"produces it).\n\n" +
				"`true` (v0.5) — MARKER: this workflow IS middleware. It is not exposed as a public " +
				"route; it is invoked by another workflow that lists this one's `name`. Middleware runs " +
				"on the parent ctx (state mutations carry forward) and can short-circuit by setting " +
				"`ctx.response` and using a step with `stop: true`. Middleware-only workflows MAY omit " +
				"`trigger`.\n\n" +
				"`string[]` (v0.5.2) — CHAIN: the workflow-level middleware chain applied TO this " +
				"workflow. Each entry is the `name` of a `middleware: true` workflow. Applies to ALL of " +
				"this workflow's triggers and runs BEFORE any trigger-level chain — use it instead of " +
				"repeating the same list under every `trigger.<kind>.middleware`. Resolution order is " +
				"process-global (`BLOK_GLOBAL_MIDDLEWARE` / `setGlobalMiddleware`) → workflow-level " +
				"(this field) → trigger-level (`trigger.<kind>.middleware`) → the workflow body. " +
				"Normalized onto `appliedMiddleware` and merged by `TriggerBase.applyMiddlewareChain`.",
		),
	steps: z.array(V2StepSchema).min(1).describe("Pipeline of steps to execute in order. At least one step required."),
	input: z
		.unknown()
		.optional()
		.describe(
			"Optional Zod schema describing the workflow's input (request body). Consumed by the `mcp` " +
				"trigger to generate each MCP tool's `inputSchema` (via zod-to-json-schema). Not validated or " +
				"serialized by the runner — it's authoring metadata carried on the workflow config.",
		),
	output: z
		.unknown()
		.optional()
		.describe(
			"Optional Zod schema (TS) or JSON Schema (JSON workflows) describing the workflow's OUTPUT — " +
				"the terminal response body. Consumed by the typed `@blokjs/client` to type each call's return " +
				"value, and (when BLOK_VALIDATE_WORKFLOW_OUTPUT=true) validated against the terminal step's " +
				"result. Authoring metadata carried on the workflow config; not serialized by the runner.",
		),
	events: z
		.record(z.unknown())
		.optional()
		.describe(
			"Optional map of SSE event name → Zod schema (TS) or JSON Schema (JSON) for STREAMING workflows. " +
				"Consumed by the typed `@blokjs/client` to type the streaming event union, and by " +
				"`@blokjs/sse-emit-typed` to constrain emitted events. Authoring metadata; not serialized.",
		),
});

export type WorkflowV2 = z.infer<typeof WorkflowV2Schema>;
export const WorkflowIRSchema = WorkflowV2Schema;
export type WorkflowIR = WorkflowV2;
export const WORKFLOW_IR_VERSION = "2" as const;
