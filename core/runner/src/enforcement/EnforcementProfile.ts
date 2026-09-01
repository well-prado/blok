import { createHash } from "node:crypto";
import {
	type CapabilityManifestV1,
	type Context,
	type EnforcementOverrideEvent,
	type EnforcementProfile,
	type PinnedPolicyIdentity,
	type PinnedWorkflowRunContract,
	type WorkflowBindingInputs,
	parseEnforcementOverrideEvent,
} from "@blokjs/shared";
import type { WorkflowBindingCatalog, WorkflowBindingResolution } from "../policy/WorkflowBinding";

export type { EnforcementProfile, WorkflowBindingInputs } from "@blokjs/shared";

export interface EnforcementSettings {
	readonly catalog?: WorkflowBindingCatalog;
	readonly input?: WorkflowBindingInputs;
	readonly defaultProfile?: EnforcementProfile;
	readonly policy?: PinnedPolicyIdentity;
	readonly capabilityManifest?: CapabilityManifestV1;
	readonly model?: {
		readonly provider?: string;
		readonly id?: string;
		readonly version?: string;
		readonly configuration?: unknown;
	};
	readonly nodeVersions?: Readonly<Record<string, string>>;
	readonly runtimeVersions?: Readonly<Record<string, string>>;
}

export type ResolvedEnforcementBinding = WorkflowBindingResolution;
export type EnforcementContract = PinnedWorkflowRunContract;
export type EnforcementOverride = EnforcementOverrideEvent;

export interface EnforcementDeviation {
	readonly stepId: string;
	readonly index: number;
	readonly reasonCode: string;
	readonly message: string;
	readonly recordedAt: string;
}

export class EnforcementBypassError extends Error {
	readonly code = "ENFORCEMENT_BYPASS_REJECTED" as const;
	constructor(message: string) {
		super(message);
		this.name = "EnforcementBypassError";
	}
}

const bindings = new WeakMap<Context, ResolvedEnforcementBinding>();
const overrides = new WeakMap<Context, Map<string, EnforcementOverride>>();

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(",")}}`;
}

/** Build the trusted workspace reference used to verify a selected binding. */
export function createWorkflowReference(workflow: {
	name: string;
	version: string;
	source?: unknown;
	ir: unknown;
}): import("@blokjs/shared").WorkflowReference {
	const hash = (value: unknown) => `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
	return {
		name: workflow.name,
		version: workflow.version,
		source: { kind: "workspace", id: workflow.name, digest: hash(workflow.source ?? workflow.ir), trusted: true },
		irDigest: hash(workflow.ir),
	};
}

export function installEnforcementBinding(ctx: Context, binding: ResolvedEnforcementBinding): void {
	bindings.set(ctx, binding);
}

export function getEnforcementBinding(ctx: Context): ResolvedEnforcementBinding | undefined {
	return bindings.get(ctx);
}

export function authorizeEnforcementOverride(ctx: Context, override: EnforcementOverride): void {
	const parsed = parseEnforcementOverrideEvent(override);
	const binding = bindings.get(ctx);
	if (parsed.profile !== "guided") throw new EnforcementBypassError("only guided enforcement accepts an override");
	if (binding?.rule && binding.rule.id !== parsed.bindingRuleId)
		throw new EnforcementBypassError(
			`override targets binding "${parsed.bindingRuleId}" instead of "${binding.rule.id}"`,
		);
	const runId = (ctx as Record<string, unknown>)._traceRunId;
	if (typeof runId === "string" && runId !== parsed.runId)
		throw new EnforcementBypassError(`override targets run "${parsed.runId}" instead of "${runId}"`);
	const map = overrides.get(ctx) ?? new Map<string, EnforcementOverride>();
	for (const stepId of parsed.scope.stepIds ?? []) map.set(stepId, parsed);
	overrides.set(ctx, map);
}

export function consumeEnforcementOverride(ctx: Context, stepId: string): EnforcementOverride | undefined {
	const map = overrides.get(ctx);
	const override = map?.get(stepId);
	map?.delete(stepId);
	return override;
}

export function assertNoStrictBypass(ctx: Context, reason: string): void {
	if (bindings.get(ctx)?.profile === "strict")
		throw new EnforcementBypassError(`strict enforcement rejected bypass: ${reason}`);
}
