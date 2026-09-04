import { createHash } from "node:crypto";
import type {
	CapabilityAuthority,
	CapabilityClassification,
	CapabilityEffect,
	CapabilityManifestV1,
	CapabilityMaturity,
	PolicyEvaluationResult,
	PolicyLayer,
	PolicyProvider,
	PolicyRequest,
	PrincipalIdentity,
	SessionIdentity,
	TurnIdentity,
	WorkflowIdentity,
} from "@blokjs/shared";
import {
	CAPABILITY_EFFECTS,
	CapabilityAuthorityError,
	CapabilityManifestError,
	assertCapabilityAuthoritySubset,
	intersectCapabilityAuthorities,
	parseCapabilityAuthority,
	parseCapabilityManifest,
} from "@blokjs/shared";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export const CODE_MODE_CONTRACT_VERSION = "1" as const;
export const CODE_MODE_MAX_BINDINGS = 128;
export const CODE_MODE_MAX_SCHEMA_BYTES = 64 * 1024;
export const CODE_MODE_MAX_DECLARATION_BYTES = 128 * 1024;
export const CODE_MODE_MAX_DESCRIPTION_LENGTH = 512;
export const CODE_MODE_MAX_ID_LENGTH = 128;

export const CODE_MODE_PHASES = ["planning", "implementing", "testing", "review"] as const;
export type CodeModePhase = (typeof CODE_MODE_PHASES)[number];
export const CODE_MODE_OUTPUT_KINDS = [
	"scalar",
	"object",
	"array",
	"null",
	"streaming",
	"background",
	"artifact-reference",
] as const;
export type CodeModeOutputKind = (typeof CODE_MODE_OUTPUT_KINDS)[number];

export type CodeModeJsonSchema = Readonly<Record<string, unknown>>;
export type CodeModeBindingKind = "workflow" | "capability";
export type CodeModeCapabilityManifest = Omit<
	CapabilityManifestV1,
	"effects" | "capabilities" | "secrets" | "runtimes" | "triggers"
> & {
	readonly effects: readonly CapabilityEffect[];
	readonly capabilities: readonly string[];
	readonly secrets: readonly string[];
	readonly runtimes?: readonly string[];
	readonly triggers?: readonly string[];
};

export interface CodeModeBindingProvenance {
	readonly contractVersion: typeof CODE_MODE_CONTRACT_VERSION;
	readonly kind: CodeModeBindingKind;
	readonly bindingId: string;
	readonly bindingVersion: string;
	readonly catalogVersion: string;
	readonly manifestDigest: string;
	readonly policyDecisionId: string;
	readonly principal: PrincipalIdentity;
	readonly session: SessionIdentity;
	readonly turn: TurnIdentity;
	readonly workflow: WorkflowIdentity;
	readonly effects: readonly CapabilityEffect[];
	readonly capabilities: readonly string[];
}

export interface CodeModeCallContext {
	readonly request: PolicyRequest;
	readonly policy: PolicyEvaluationResult;
	readonly authority: CapabilityAuthority;
	readonly provenance: CodeModeBindingProvenance;
}

export interface CodeModeBindingExecutionResult<T> {
	readonly value: T;
	readonly provenance: CodeModeBindingProvenance;
}

export interface CodeModeBindingDefinitionBase<TInputSchema extends z.ZodTypeAny, TOutputSchema extends z.ZodTypeAny> {
	readonly id: string;
	readonly version: string;
	readonly description: string;
	readonly input: TInputSchema;
	readonly output: TOutputSchema;
	readonly outputKind: CodeModeOutputKind;
	readonly capabilityManifest: CodeModeCapabilityManifest;
	readonly authority?: CapabilityAuthority;
	readonly phases?: readonly CodeModePhase[];
	readonly principals?: readonly string[];
	readonly implementationOnly?: boolean;
	readonly invoke: (
		input: z.infer<TInputSchema>,
		context: CodeModeCallContext,
	) => z.infer<TOutputSchema> | Promise<z.infer<TOutputSchema>>;
}

export interface CodeModeWorkflowDefinition<TInputSchema extends z.ZodTypeAny, TOutputSchema extends z.ZodTypeAny>
	extends CodeModeBindingDefinitionBase<TInputSchema, TOutputSchema> {
	readonly kind: "workflow";
	readonly runtime?: string;
}

export interface CodeModeCapabilityDefinition<TInputSchema extends z.ZodTypeAny, TOutputSchema extends z.ZodTypeAny>
	extends CodeModeBindingDefinitionBase<TInputSchema, TOutputSchema> {
	readonly kind: "capability";
}

export interface CodeModeBindingDescriptor {
	readonly contractVersion: typeof CODE_MODE_CONTRACT_VERSION;
	readonly kind: CodeModeBindingKind;
	readonly id: string;
	readonly version: string;
	readonly name: string;
	readonly description: string;
	readonly inputSchema: CodeModeJsonSchema;
	readonly outputSchema: CodeModeJsonSchema;
	readonly outputKind: CodeModeOutputKind;
	readonly effects: readonly CapabilityEffect[];
	readonly capabilities: readonly string[];
	readonly maturity: CapabilityMaturity;
	readonly runtime?: string;
	readonly phases: readonly CodeModePhase[];
	readonly implementationOnly: boolean;
}

export interface CodeModeCatalogEntry<
	TInputSchema extends z.ZodTypeAny = z.ZodTypeAny,
	TOutputSchema extends z.ZodTypeAny = z.ZodTypeAny,
> {
	readonly descriptor: CodeModeBindingDescriptor;
	readonly definition:
		| CodeModeWorkflowDefinition<TInputSchema, TOutputSchema>
		| CodeModeCapabilityDefinition<TInputSchema, TOutputSchema>;
	readonly input: TInputSchema;
	readonly output: TOutputSchema;
	readonly authority: CapabilityAuthority;
	readonly manifest: CapabilityManifestV1;
}

export interface CodeModeCatalog<TEntries extends readonly unknown[] = readonly CodeModeCatalogEntry[]> {
	readonly version: string;
	readonly entries: TEntries;
}

export interface CodeModeInvocationIdentity {
	readonly principal: PrincipalIdentity;
	readonly session: SessionIdentity;
	readonly turn: TurnIdentity;
	readonly workflow: WorkflowIdentity;
	readonly layers?: readonly PolicyLayer[];
	readonly authority?: CapabilityAuthority;
	readonly signal?: AbortSignal;
}

export interface CodeModePolicyOptions {
	readonly provider: PolicyProvider;
	readonly policyVersion: string;
	readonly identity: CodeModeInvocationIdentity;
}

export interface CodeModeGenerationOptions extends CodeModePolicyOptions {
	readonly phase: CodeModePhase;
	readonly runtime?: string;
	readonly allowedMaturity?: readonly CapabilityMaturity[];
	readonly maxBindings?: number;
	readonly maxDeclarationBytes?: number;
}

export interface CodeModeInvocationOptions extends CodeModePolicyOptions {
	readonly catalogVersion: string;
	readonly binding: CodeModeCatalogEntry;
	readonly stepId?: string;
}

export interface CodeModeUnavailableBinding {
	readonly id: string;
	readonly kind: CodeModeBindingKind;
	readonly name: string;
	readonly reasonCode:
		| "implementation-only"
		| "phase-unavailable"
		| "principal-unavailable"
		| "runtime-unavailable"
		| "maturity-unavailable"
		| "manifest-invalid"
		| "authority-unavailable"
		| "policy-denied"
		| "policy-approval-required";
}

export interface CodeModeGeneratedBinding {
	readonly descriptor: CodeModeBindingDescriptor;
	readonly stableName: string;
	readonly invoke: (input: unknown) => Promise<unknown>;
}

export interface CodeModeGeneratedSurface {
	readonly contractVersion: typeof CODE_MODE_CONTRACT_VERSION;
	readonly catalogVersion: string;
	readonly phase: CodeModePhase;
	readonly bindings: readonly CodeModeGeneratedBinding[];
	readonly unavailable: readonly CodeModeUnavailableBinding[];
	readonly declarations: string;
	readonly prompt: string;
	readonly truncated: boolean;
	readonly cacheKey: string;
}

export type CodeModeBindingErrorCode =
	| "INVALID_CONTRACT"
	| "CATALOG_LIMIT_EXCEEDED"
	| "DECLARATION_LIMIT_EXCEEDED"
	| "NAME_COLLISION"
	| "BINDING_UNAVAILABLE"
	| "BINDING_DENIED"
	| "POLICY_STALE"
	| "POLICY_MALFORMED"
	| "POLICY_DENIED"
	| "POLICY_APPROVAL_REQUIRED"
	| "SANDBOX_REQUIRED"
	| "AUTHORITY_WIDENED"
	| "INPUT_INVALID"
	| "OUTPUT_INVALID"
	| "OUTPUT_KIND_MISMATCH"
	| "OUTPUT_NOT_SERIALIZABLE";

export class CodeModeBindingError extends Error {
	readonly name = "CodeModeBindingError";

	constructor(
		public readonly code: CodeModeBindingErrorCode,
		message: string,
		public readonly bindingId?: string,
	) {
		super(message);
	}
}

const id = z
	.string()
	.min(1)
	.max(CODE_MODE_MAX_ID_LENGTH)
	.regex(/^[A-Za-z][A-Za-z0-9._:/-]*$/);
const version = z.string().min(1).max(CODE_MODE_MAX_ID_LENGTH);
const schema = z.record(z.unknown());
const descriptorSchema = z.object({
	contractVersion: z.literal(CODE_MODE_CONTRACT_VERSION),
	kind: z.enum(["workflow", "capability"]),
	id,
	version,
	name: z
		.string()
		.min(1)
		.max(CODE_MODE_MAX_ID_LENGTH)
		.regex(/^[A-Za-z][A-Za-z0-9_]*$/),
	description: z.string().min(1).max(CODE_MODE_MAX_DESCRIPTION_LENGTH),
	inputSchema: schema,
	outputSchema: schema,
	outputKind: z.enum(CODE_MODE_OUTPUT_KINDS),
	effects: z.array(z.enum(CAPABILITY_EFFECTS)).max(16),
	capabilities: z.array(id).max(256),
	maturity: z.enum(["stable", "beta", "experimental", "deprecated"]),
	runtime: id.optional(),
	phases: z.array(z.enum(CODE_MODE_PHASES)).min(1).max(CODE_MODE_PHASES.length),
	implementationOnly: z.boolean(),
});

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function stableStringify(value: unknown): string {
	if (
		typeof value === "undefined" ||
		typeof value === "function" ||
		typeof value === "symbol" ||
		typeof value === "bigint"
	)
		throw new CodeModeBindingError("OUTPUT_NOT_SERIALIZABLE", "value is not JSON serializable");
	if (typeof value === "number" && !Number.isFinite(value))
		throw new CodeModeBindingError("OUTPUT_NOT_SERIALIZABLE", "value is not JSON serializable");
	if (value === null || typeof value !== "object") {
		const result = JSON.stringify(value);
		if (result === undefined)
			throw new CodeModeBindingError("OUTPUT_NOT_SERIALIZABLE", "value is not JSON serializable");
		return result;
	}
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null)
		throw new CodeModeBindingError("OUTPUT_NOT_SERIALIZABLE", "value is not a JSON object");
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort(compareStrings)
		.filter((key) => record[key] !== undefined)
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(",")}}`;
}

function immutable<T>(value: T): T {
	const copy = structuredClone(value);
	const freeze = (current: unknown): void => {
		if (current === null || typeof current !== "object" || Object.isFrozen(current)) return;
		for (const child of Object.values(current)) freeze(child);
		Object.freeze(current);
	};
	freeze(copy);
	return copy;
}

function normalizedList(values: readonly string[]): string[] {
	return [...new Set(values)].sort(compareStrings);
}

function schemaJson(value: z.ZodTypeAny, label: string): CodeModeJsonSchema {
	const result = zodToJsonSchema(value, { $refStrategy: "none", target: "jsonSchema7" }) as CodeModeJsonSchema;
	if (new TextEncoder().encode(stableStringify(result)).byteLength > CODE_MODE_MAX_SCHEMA_BYTES)
		throw new CodeModeBindingError("INVALID_CONTRACT", `${label} schema exceeds the Code Mode schema limit`);
	return result;
}

function manifestAuthority(manifest: CapabilityManifestV1): CapabilityAuthority {
	return parseCapabilityAuthority({
		effects: manifest.effects,
		capabilities: manifest.capabilities,
		secrets: manifest.secrets,
		fragments: {},
	});
}

function digest(value: unknown): string {
	return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

export function capabilityManifestDigest(manifest: CapabilityManifestV1): string {
	return digest(manifest);
}

export function parseCodeModeDescriptor(value: unknown): CodeModeBindingDescriptor {
	const result = descriptorSchema.safeParse(value);
	if (!result.success) {
		const issues = result.error.issues
			.map((issue) => `descriptor${issue.path.length ? `.${issue.path.join(".")}` : ""} ${issue.message}`)
			.sort(compareStrings);
		throw new CodeModeBindingError("INVALID_CONTRACT", issues.join("; "));
	}
	return immutable({
		...result.data,
		effects: normalizedList(result.data.effects) as CapabilityEffect[],
		capabilities: normalizedList(result.data.capabilities),
		phases: [...new Set(result.data.phases)].sort(compareStrings) as CodeModePhase[],
	});
}

export function serializeCodeModeDescriptor(value: unknown): string {
	return stableStringify(parseCodeModeDescriptor(value));
}

export function serializeCodeModeSurface(value: CodeModeGeneratedSurface): string {
	return stableStringify({
		contractVersion: value.contractVersion,
		catalogVersion: value.catalogVersion,
		phase: value.phase,
		bindings: value.bindings.map((binding) => binding.descriptor),
		unavailable: value.unavailable,
		declarations: value.declarations,
		prompt: value.prompt,
		truncated: value.truncated,
		cacheKey: value.cacheKey,
	});
}

export function bindingName(kind: CodeModeBindingKind, id: string): string {
	const safe = id.replace(/[^A-Za-z0-9_]/g, "_");
	const prefixed = /^[A-Za-z]/.test(safe) ? safe : `n_${safe}`;
	return `${kind}_${prefixed}`;
}

export function makeDescriptor<TInputSchema extends z.ZodTypeAny, TOutputSchema extends z.ZodTypeAny>(
	definition:
		| CodeModeWorkflowDefinition<TInputSchema, TOutputSchema>
		| CodeModeCapabilityDefinition<TInputSchema, TOutputSchema>,
): CodeModeCatalogEntry<TInputSchema, TOutputSchema> {
	let manifest: CapabilityManifestV1;
	try {
		manifest = parseCapabilityManifest(definition.capabilityManifest);
	} catch (error) {
		if (error instanceof CapabilityManifestError)
			throw new CodeModeBindingError("INVALID_CONTRACT", error.message, definition.id);
		throw error;
	}
	if (manifest.classification !== ("agent-compatible" satisfies CapabilityClassification))
		throw new CodeModeBindingError(
			"INVALID_CONTRACT",
			"Code Mode bindings require an agent-compatible manifest",
			definition.id,
		);
	let authority: CapabilityAuthority;
	try {
		authority = definition.authority ? parseCapabilityAuthority(definition.authority) : manifestAuthority(manifest);
		assertCapabilityAuthoritySubset(authority, manifestAuthority(manifest), "binding authority");
		assertCapabilityAuthoritySubset(manifestAuthority(manifest), authority, "binding manifest authority");
	} catch (error) {
		if (error instanceof CapabilityAuthorityError)
			throw new CodeModeBindingError("INVALID_CONTRACT", error.message, definition.id);
		throw error;
	}
	const phases = definition.phases === undefined ? [...CODE_MODE_PHASES] : [...new Set(definition.phases)];
	if (phases.length === 0 || phases.some((phase) => !CODE_MODE_PHASES.includes(phase)))
		throw new CodeModeBindingError("INVALID_CONTRACT", "binding phases are invalid", definition.id);
	const descriptor = parseCodeModeDescriptor({
		contractVersion: CODE_MODE_CONTRACT_VERSION,
		kind: definition.kind,
		id: definition.id,
		version: definition.version,
		name: bindingName(definition.kind, definition.id),
		description: definition.description,
		inputSchema: schemaJson(definition.input, "input"),
		outputSchema: schemaJson(definition.output, "output"),
		outputKind: definition.outputKind,
		effects: manifest.effects,
		capabilities: manifest.capabilities,
		maturity: manifest.maturity,
		...(definition.kind === "workflow" && definition.runtime ? { runtime: definition.runtime } : {}),
		phases,
		implementationOnly: definition.implementationOnly === true,
	});
	return { descriptor, definition, input: definition.input, output: definition.output, authority, manifest };
}

export function catalogDigest(catalog: CodeModeCatalog): string {
	return digest({ version: catalog.version, entries: catalog.entries.map((entry) => entry.descriptor) });
}

export function effectiveAuthority(
	active: CapabilityAuthority | undefined,
	binding: CapabilityAuthority,
): CapabilityAuthority {
	if (active === undefined) return binding;
	assertCapabilityAuthoritySubset(binding, active, "binding authority");
	return intersectCapabilityAuthorities(active, binding);
}

export function policyRequestFor(
	options: CodeModeInvocationOptions,
	decisionStepId: string,
): { request: PolicyRequest; authority: CapabilityAuthority } {
	let authority: CapabilityAuthority;
	try {
		authority = effectiveAuthority(options.identity.authority, options.binding.authority);
	} catch (error) {
		if (error instanceof CapabilityAuthorityError)
			throw new CodeModeBindingError(
				"AUTHORITY_WIDENED",
				"binding authority exceeds the active authority",
				options.binding.descriptor.id,
			);
		throw error;
	}
	const request: PolicyRequest = {
		requestId: `${options.identity.session.id}:${options.identity.turn.id}:${options.binding.descriptor.id}`,
		origin: "agent",
		principal: options.identity.principal,
		session: options.identity.session,
		turn: options.identity.turn,
		workflow: options.identity.workflow,
		step: { id: decisionStepId },
		manifest: options.binding.manifest,
		scope: authority,
		layers: options.identity.layers ?? [],
		signal: options.identity.signal,
	};
	return { request, authority };
}

export function policyDecisionAuthority(
	request: PolicyRequest,
	result: PolicyEvaluationResult,
	bindingId: string,
): CapabilityAuthority {
	if (!result.decision || !result.decision.id || !result.decision.reasonCode)
		throw new CodeModeBindingError("POLICY_MALFORMED", "policy decision is incomplete", bindingId);
	if (result.scope === undefined) return request.scope;
	try {
		const scope = parseCapabilityAuthority(result.scope);
		assertCapabilityAuthoritySubset(scope, request.scope, "policy scope");
		return intersectCapabilityAuthorities(request.scope, scope);
	} catch (error) {
		if (error instanceof CapabilityAuthorityError)
			throw new CodeModeBindingError("POLICY_MALFORMED", "policy scope exceeds the requested authority", bindingId);
		throw error;
	}
}

export function descriptorManifestDigest(entry: CodeModeCatalogEntry): string {
	return capabilityManifestDigest(entry.manifest);
}
