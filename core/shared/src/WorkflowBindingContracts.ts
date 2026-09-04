import { z } from "zod";
import { ENFORCEMENT_PROFILES, type EnforcementProfile, EnforcementProfileSchema } from "./EnforcementProfileContracts";
import type { PrincipalIdentity } from "./PolicyContracts";

/** Version of the language-neutral workflow binding contract. */
export const WORKFLOW_BINDING_CONTRACT_VERSION = "1" as const;
export const WORKFLOW_RUN_CONTRACT_VERSION = "1" as const;
export const ENFORCEMENT_OVERRIDE_EVENT_VERSION = "1" as const;

export const WORKFLOW_BINDING_MAX_RULES = 128;
export const WORKFLOW_BINDING_MAX_LABELS = 128;
export const WORKFLOW_BINDING_MAX_PATHS = 128;
export const WORKFLOW_BINDING_MAX_ATTRIBUTES = 64;
export const WORKFLOW_BINDING_MAX_NODES = 512;
export const WORKFLOW_BINDING_MAX_RUNTIMES = 32;
export const WORKFLOW_BINDING_MAX_SCOPE_ITEMS = 128;
export const WORKFLOW_BINDING_MAX_STRING_LENGTH = 256;
export const WORKFLOW_BINDING_MAX_CONTRACT_BYTES = 512 * 1024;

export const WORKFLOW_SOURCE_KINDS = ["registry", "repository", "workspace"] as const;
export const WORKFLOW_RUNTIME_KINDS = [
	"nodejs",
	"bun",
	"python3",
	"go",
	"java",
	"rust",
	"php",
	"csharp",
	"ruby",
	"docker",
	"wasm",
	"wasi",
] as const;

export type WorkflowSourceKind = (typeof WORKFLOW_SOURCE_KINDS)[number];
export type WorkflowRuntimeKind = (typeof WORKFLOW_RUNTIME_KINDS)[number];
export type BindingScalar = string | number | boolean;

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/;
const DIGEST = /^(sha256):[0-9a-f]{64}$|^(sha512):[0-9a-f]{128}$/i;
const PATH = /^[^\0]{1,256}$/;
const identifier = z.string().min(1).max(128).regex(IDENTIFIER, "must be a bounded identifier");
const boundedString = z.string().min(1).max(WORKFLOW_BINDING_MAX_STRING_LENGTH);
const digest = z
	.string()
	.max(140)
	.regex(DIGEST, "must be a sha256: or sha512: digest with the complete hexadecimal length")
	.transform((value) => value.toLowerCase());
const version = boundedString;
const finiteNumber = z.number().finite();
const bindingScalar = z.union([boundedString, finiteNumber, z.boolean()]);
const stringList = (limit: number, valueSchema: z.ZodType<string> = identifier) =>
	z.array(valueSchema).min(1).max(limit);

const scalarRecord = z
	.record(identifier, bindingScalar)
	.refine(
		(value) => Object.keys(value).length <= WORKFLOW_BINDING_MAX_ATTRIBUTES,
		`must contain at most ${WORKFLOW_BINDING_MAX_ATTRIBUTES} attributes`,
	);

export interface RepositoryIdentity {
	readonly provider: string;
	readonly id: string;
	readonly revision?: string;
}

export interface BindingActorIdentity extends PrincipalIdentity {}

/** Runtime facts used to select a binding; no payloads or secrets are allowed. */
export interface WorkflowBindingInputs {
	readonly repository?: RepositoryIdentity;
	readonly taskType?: string;
	readonly labels?: readonly string[];
	readonly paths?: readonly string[];
	readonly tenant?: string;
	readonly actor?: BindingActorIdentity;
	readonly environment?: string;
	readonly attributes?: Readonly<Record<string, BindingScalar>>;
}

export interface WorkflowBindingSelector {
	readonly repository?: RepositoryIdentity;
	readonly taskTypes?: readonly string[];
	/** Every listed label is required; labels are normalized as a set. */
	readonly labels?: readonly string[];
	/** A selector path matches by the resolver's documented path policy. */
	readonly paths?: readonly string[];
	readonly tenant?: string;
	readonly actors?: readonly string[];
	readonly environments?: readonly string[];
	readonly attributes?: Readonly<Record<string, BindingScalar>>;
}

export interface TrustedWorkflowSource {
	readonly kind: WorkflowSourceKind;
	readonly id: string;
	readonly digest: string;
	readonly trusted: true;
}

export interface WorkflowReference {
	readonly name: string;
	readonly version: string;
	readonly source: TrustedWorkflowSource;
	readonly irDigest: string;
}

export interface WorkflowBindingRule {
	readonly version: typeof WORKFLOW_BINDING_CONTRACT_VERSION;
	readonly id: string;
	readonly priority: number;
	readonly selector: WorkflowBindingSelector;
	readonly workflow: WorkflowReference;
	readonly profile: EnforcementProfile;
}

export type WorkflowBindingRules = readonly WorkflowBindingRule[];

export interface PinnedNodeIdentity {
	readonly id: string;
	readonly version: string;
	readonly digest?: string;
}

export interface PinnedRuntimeIdentity {
	readonly kind: WorkflowRuntimeKind;
	readonly version: string;
}

export interface PinnedCapabilityManifestIdentity {
	readonly version: string;
	readonly digest: string;
}

export interface PinnedPolicyIdentity {
	readonly id: string;
	readonly version: string;
	readonly digest?: string;
}

export interface PinnedModelConfigurationIdentity {
	readonly provider: string;
	readonly id: string;
	readonly version: string;
	readonly configDigest: string;
}

/** Immutable execution contract captured before a bound run starts. */
export interface PinnedWorkflowRunContract {
	readonly version: typeof WORKFLOW_RUN_CONTRACT_VERSION;
	readonly runId: string;
	readonly profile: EnforcementProfile;
	readonly bindingRuleId: string;
	readonly boundAt: string;
	readonly workflow: WorkflowReference;
	readonly nodes: readonly PinnedNodeIdentity[];
	readonly runtimes: readonly PinnedRuntimeIdentity[];
	readonly capabilityManifest: PinnedCapabilityManifestIdentity;
	readonly policy: PinnedPolicyIdentity;
	readonly model: PinnedModelConfigurationIdentity;
}

export interface EnforcementOverrideScope {
	readonly stepIds?: readonly string[];
	readonly transitionIds?: readonly string[];
	readonly capabilityIds?: readonly string[];
}

export interface EnforcementOverrideAuthorization {
	readonly method: "durable-interaction";
	readonly interactionId: string;
	readonly decisionId: string;
	readonly status: "answered";
}

/** Append-only event authorizing one bounded deviation in guided mode. */
export interface EnforcementOverrideEvent {
	readonly version: typeof ENFORCEMENT_OVERRIDE_EVENT_VERSION;
	readonly eventType: "enforcement.override";
	readonly eventId: string;
	readonly timestamp: string;
	readonly runId: string;
	readonly profile: "guided";
	readonly bindingRuleId: string;
	readonly requestedBy?: BindingActorIdentity;
	readonly authorizedBy: BindingActorIdentity;
	readonly authorization: EnforcementOverrideAuthorization;
	readonly reasonCode: string;
	readonly reason?: string;
	readonly scope: EnforcementOverrideScope;
	readonly expiresAt?: string;
}

const repositoryIdentitySchema = z.object({
	provider: identifier,
	id: identifier,
	revision: boundedString.optional(),
});

const actorIdentitySchema = z.object({
	id: identifier,
	kind: identifier,
});

const pathList = stringList(WORKFLOW_BINDING_MAX_PATHS, z.string().regex(PATH, "must be a bounded path"));
const labels = stringList(WORKFLOW_BINDING_MAX_LABELS);

export const WorkflowBindingInputsSchema = z.object({
	repository: repositoryIdentitySchema.optional(),
	taskType: boundedString.optional(),
	labels: labels.optional(),
	paths: pathList.optional(),
	tenant: boundedString.optional(),
	actor: actorIdentitySchema.optional(),
	environment: boundedString.optional(),
	attributes: scalarRecord.optional(),
});

export const WorkflowBindingSelectorSchema = z.object({
	repository: repositoryIdentitySchema.optional(),
	taskTypes: stringList(WORKFLOW_BINDING_MAX_LABELS, boundedString).optional(),
	labels: labels.optional(),
	paths: pathList.optional(),
	tenant: boundedString.optional(),
	actors: stringList(WORKFLOW_BINDING_MAX_LABELS).optional(),
	environments: stringList(WORKFLOW_BINDING_MAX_LABELS, boundedString).optional(),
	attributes: scalarRecord.optional(),
});

const trustedSourceSchema = z.object({
	kind: z.enum(WORKFLOW_SOURCE_KINDS),
	id: identifier,
	digest,
	trusted: z.literal(true),
});

const workflowReferenceSchema = z.object({
	name: identifier,
	version,
	source: trustedSourceSchema,
	irDigest: digest,
});

export const WorkflowBindingRuleSchema = z.object({
	version: z.literal(WORKFLOW_BINDING_CONTRACT_VERSION),
	id: identifier,
	priority: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	selector: WorkflowBindingSelectorSchema,
	workflow: workflowReferenceSchema,
	profile: EnforcementProfileSchema,
});

export const WorkflowBindingRulesSchema = z
	.array(WorkflowBindingRuleSchema)
	.min(1)
	.max(WORKFLOW_BINDING_MAX_RULES)
	.superRefine((value, context) => {
		const ids = new Set<string>();
		for (const [index, rule] of value.entries()) {
			if (ids.has(rule.id)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: [index, "id"],
					message: "rule ids must be unique",
				});
			}
			ids.add(rule.id);
		}
	});

const pinnedNodeSchema = z.object({ id: identifier, version, digest: digest.optional() });
const pinnedRuntimeSchema = z.object({ kind: z.enum(WORKFLOW_RUNTIME_KINDS), version });

const pinnedCapabilityManifestSchema = z.object({ version, digest });
const pinnedPolicySchema = z.object({ id: identifier, version, digest: digest.optional() });
const pinnedModelSchema = z.object({ provider: identifier, id: identifier, version, configDigest: digest });

export const PinnedWorkflowRunContractSchema = z
	.object({
		version: z.literal(WORKFLOW_RUN_CONTRACT_VERSION),
		runId: identifier,
		profile: EnforcementProfileSchema,
		bindingRuleId: identifier,
		boundAt: boundedString,
		workflow: workflowReferenceSchema,
		nodes: z.array(pinnedNodeSchema).min(1).max(WORKFLOW_BINDING_MAX_NODES),
		runtimes: z.array(pinnedRuntimeSchema).min(1).max(WORKFLOW_BINDING_MAX_RUNTIMES),
		capabilityManifest: pinnedCapabilityManifestSchema,
		policy: pinnedPolicySchema,
		model: pinnedModelSchema,
	})
	.superRefine((value, context) => {
		const nodeIds = new Set<string>();
		for (const [index, node] of value.nodes.entries()) {
			if (nodeIds.has(node.id)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["nodes", index, "id"],
					message: "node ids must be unique",
				});
			}
			nodeIds.add(node.id);
		}
		const runtimeKinds = new Set<string>();
		for (const [index, runtime] of value.runtimes.entries()) {
			if (runtimeKinds.has(runtime.kind)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["runtimes", index, "kind"],
					message: "runtime kinds must be unique",
				});
			}
			runtimeKinds.add(runtime.kind);
		}
	});

const scopeList = z.array(identifier).min(1).max(WORKFLOW_BINDING_MAX_SCOPE_ITEMS);
export const EnforcementOverrideScopeSchema = z
	.object({
		stepIds: scopeList.optional(),
		transitionIds: scopeList.optional(),
		capabilityIds: scopeList.optional(),
	})
	.superRefine((value, context) => {
		if (value.stepIds === undefined && value.transitionIds === undefined && value.capabilityIds === undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "scope must name at least one step, transition, or capability",
			});
		}
	});

const overrideAuthorizationSchema = z.object({
	method: z.literal("durable-interaction"),
	interactionId: identifier,
	decisionId: identifier,
	status: z.literal("answered"),
});

export const EnforcementOverrideEventSchema = z.object({
	version: z.literal(ENFORCEMENT_OVERRIDE_EVENT_VERSION),
	eventType: z.literal("enforcement.override"),
	eventId: identifier,
	timestamp: boundedString,
	runId: identifier,
	profile: z.literal("guided"),
	bindingRuleId: identifier,
	requestedBy: actorIdentitySchema.optional(),
	authorizedBy: actorIdentitySchema,
	authorization: overrideAuthorizationSchema,
	reasonCode: identifier,
	reason: boundedString.optional(),
	scope: EnforcementOverrideScopeSchema,
	expiresAt: boundedString.optional(),
});

export class WorkflowBindingContractError extends Error {
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(`Invalid workflow binding contract: ${issues.join("; ")}`);
		this.name = "WorkflowBindingContractError";
		this.issues = [...issues];
	}
}

function sortUnique(values: readonly string[]): string[] {
	return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function normalizeAttributes(value: Readonly<Record<string, BindingScalar>>): Readonly<Record<string, BindingScalar>> {
	const result: Record<string, BindingScalar> = {};
	for (const key of Object.keys(value).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
		result[key] = value[key];
	}
	return result;
}

function normalizeRepository(value: z.infer<typeof repositoryIdentitySchema>): RepositoryIdentity {
	return {
		provider: value.provider,
		id: value.id,
		...(value.revision === undefined ? {} : { revision: value.revision }),
	};
}

function normalizeInputs(value: z.infer<typeof WorkflowBindingInputsSchema>): WorkflowBindingInputs {
	return {
		...(value.repository ? { repository: normalizeRepository(value.repository) } : {}),
		...(value.taskType === undefined ? {} : { taskType: value.taskType }),
		...(value.labels ? { labels: sortUnique(value.labels) } : {}),
		...(value.paths ? { paths: sortUnique(value.paths) } : {}),
		...(value.tenant === undefined ? {} : { tenant: value.tenant }),
		...(value.actor ? { actor: { ...value.actor } } : {}),
		...(value.environment === undefined ? {} : { environment: value.environment }),
		...(value.attributes ? { attributes: normalizeAttributes(value.attributes) } : {}),
	};
}

function normalizeSelector(value: z.infer<typeof WorkflowBindingSelectorSchema>): WorkflowBindingSelector {
	return {
		...(value.repository ? { repository: normalizeRepository(value.repository) } : {}),
		...(value.taskTypes ? { taskTypes: sortUnique(value.taskTypes) } : {}),
		...(value.labels ? { labels: sortUnique(value.labels) } : {}),
		...(value.paths ? { paths: sortUnique(value.paths) } : {}),
		...(value.tenant === undefined ? {} : { tenant: value.tenant }),
		...(value.actors ? { actors: sortUnique(value.actors) } : {}),
		...(value.environments ? { environments: sortUnique(value.environments) } : {}),
		...(value.attributes ? { attributes: normalizeAttributes(value.attributes) } : {}),
	};
}

function parseSchema<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
	const result = schema.safeParse(value);
	if (!result.success) {
		throw new WorkflowBindingContractError(
			result.error.issues.map(
				(issue) => `${label}${issue.path.length > 0 ? `.${issue.path.join(".")}` : ""} ${issue.message}`,
			),
		);
	}
	return result.data;
}

function normalizeScope(value: z.infer<typeof EnforcementOverrideScopeSchema>): EnforcementOverrideScope {
	return {
		...(value.stepIds ? { stepIds: sortUnique(value.stepIds) } : {}),
		...(value.transitionIds ? { transitionIds: sortUnique(value.transitionIds) } : {}),
		...(value.capabilityIds ? { capabilityIds: sortUnique(value.capabilityIds) } : {}),
	};
}

function assertContractSize<T>(value: T, label: string): T {
	const serialized = JSON.stringify(value);
	if (new TextEncoder().encode(serialized).byteLength > WORKFLOW_BINDING_MAX_CONTRACT_BYTES) {
		throw new WorkflowBindingContractError([`${label} exceeds ${WORKFLOW_BINDING_MAX_CONTRACT_BYTES} bytes`]);
	}
	return value;
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

/** Parse and canonicalize caller-controlled binding facts. */
export function parseWorkflowBindingInputs(value: unknown): WorkflowBindingInputs {
	return immutable(normalizeInputs(parseSchema(WorkflowBindingInputsSchema, value, "workflow binding inputs")));
}

export function parseWorkflowBindingSelector(value: unknown): WorkflowBindingSelector {
	return immutable(normalizeSelector(parseSchema(WorkflowBindingSelectorSchema, value, "workflow binding selector")));
}

export function parseWorkflowBindingRule(value: unknown): WorkflowBindingRule {
	const parsed = parseSchema(WorkflowBindingRuleSchema, value, "workflow binding rule");
	return immutable(
		assertContractSize(
			{
				...parsed,
				selector: normalizeSelector(parsed.selector),
			},
			"workflow binding rule",
		),
	);
}

export function parseWorkflowBindingRules(value: unknown): WorkflowBindingRules {
	const parsed = parseSchema(WorkflowBindingRulesSchema, value, "workflow binding rules");
	return immutable(
		assertContractSize(
			parsed
				.map((rule) => ({ ...rule, selector: normalizeSelector(rule.selector) }))
				.sort((left, right) =>
					left.priority !== right.priority
						? right.priority - left.priority
						: left.id < right.id
							? -1
							: left.id > right.id
								? 1
								: 0,
				),
			"workflow binding rules",
		),
	);
}

/** Parse a complete run contract; the returned value is safe to persist as a pin. */
export function parsePinnedWorkflowRunContract(value: unknown): PinnedWorkflowRunContract {
	const parsed = parseSchema(PinnedWorkflowRunContractSchema, value, "pinned workflow run contract");
	return immutable(
		assertContractSize(
			{
				...parsed,
				nodes: [...parsed.nodes].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
				runtimes: [...parsed.runtimes].sort((left, right) =>
					left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0,
				),
			},
			"pinned workflow run contract",
		),
	);
}

/** Parse a guided authorization event; strict/advisory bypass events are invalid. */
export function parseEnforcementOverrideEvent(value: unknown): EnforcementOverrideEvent {
	const parsed = parseSchema(EnforcementOverrideEventSchema, value, "enforcement override event");
	return immutable(
		assertContractSize({ ...parsed, scope: normalizeScope(parsed.scope) }, "enforcement override event"),
	);
}

export function serializeWorkflowBindingInputs(value: unknown): string {
	return JSON.stringify(parseWorkflowBindingInputs(value));
}

export function serializeWorkflowBindingRule(value: unknown): string {
	return JSON.stringify(parseWorkflowBindingRule(value));
}

export function serializeWorkflowBindingRules(value: unknown): string {
	return JSON.stringify(parseWorkflowBindingRules(value));
}

export function serializePinnedWorkflowRunContract(value: unknown): string {
	return JSON.stringify(parsePinnedWorkflowRunContract(value));
}

export function serializeEnforcementOverrideEvent(value: unknown): string {
	return JSON.stringify(parseEnforcementOverrideEvent(value));
}

export function isEnforcementProfile(value: unknown): value is EnforcementProfile {
	return typeof value === "string" && (ENFORCEMENT_PROFILES as readonly string[]).includes(value);
}
