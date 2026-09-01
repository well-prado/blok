import { createHash } from "node:crypto";
import {
	type BindingActorIdentity,
	type BindingScalar,
	ENFORCEMENT_PROFILES,
	type EnforcementProfile,
	type PinnedCapabilityManifestIdentity,
	type PinnedModelConfigurationIdentity,
	type PinnedNodeIdentity,
	type PinnedPolicyIdentity,
	type PinnedRuntimeIdentity,
	type PinnedWorkflowRunContract,
	type RepositoryIdentity,
	type TrustedWorkflowSource,
	type WorkflowBindingInputs,
	type WorkflowBindingRule,
	type WorkflowBindingRules,
	type WorkflowBindingSelector,
	type WorkflowReference,
	enforcementProfileSemantics,
	parsePinnedWorkflowRunContract,
	parseWorkflowBindingInputs,
	parseWorkflowBindingRules,
} from "@blokjs/shared";

export type {
	EnforcementProfile,
	BindingActorIdentity,
	BindingScalar,
	PinnedCapabilityManifestIdentity,
	PinnedModelConfigurationIdentity,
	PinnedNodeIdentity,
	PinnedPolicyIdentity,
	PinnedRuntimeIdentity,
	PinnedWorkflowRunContract,
	WorkflowBindingInputs,
	WorkflowBindingRule,
	WorkflowBindingRules,
	WorkflowBindingSelector,
	WorkflowReference,
	RepositoryIdentity,
	TrustedWorkflowSource,
};

export interface WorkflowBindingCatalog {
	readonly rules: WorkflowBindingRules;
	/** Current trusted workflow references. Omit to use references embedded in rules. */
	readonly workflows?: readonly WorkflowReference[];
}

export interface BindingResolutionInput {
	readonly inputs: WorkflowBindingInputs;
	readonly catalog: WorkflowBindingCatalog;
}

export type BindingResolutionStatus = "resolved" | "unbound" | "denied";

export type BindingReasonCode =
	| "binding-resolved"
	| "no-binding-match"
	| "binding-rule-invalid"
	| "strict-binding-ambiguous"
	| "binding-source-untrusted"
	| "binding-source-missing"
	| "binding-source-version-unavailable";

export interface BindingExplanation {
	readonly reasonCode: BindingReasonCode;
	readonly message: string;
	readonly matchedRuleIds: readonly string[];
	readonly winningRuleIds: readonly string[];
}

export interface BindingRuleCandidate {
	readonly rule: WorkflowBindingRule;
	readonly specificity: number;
}

export interface WorkflowBindingMatch {
	readonly rule: WorkflowBindingRule;
	readonly specificity: number;
}

export interface WorkflowBindingResolution {
	readonly status: BindingResolutionStatus;
	readonly profile: EnforcementProfile;
	readonly rule?: WorkflowBindingRule;
	readonly workflow?: WorkflowReference;
	readonly matchedRules: readonly WorkflowBindingMatch[];
	readonly explanation: BindingExplanation;
}

export interface ProfileEvaluationInput {
	readonly deviation: boolean;
	readonly authorizedOverride?: boolean;
	readonly reason?: string;
	readonly scope?: string;
}

export interface ProfileEvaluation {
	readonly allowed: boolean;
	readonly recorded: boolean;
	readonly reasonCode:
		| "no-deviation"
		| "advisory-recorded"
		| "guided-override-required"
		| "guided-override"
		| "strict-bypass-denied";
	readonly reason?: string;
}

export interface WorkflowBindingPinInput {
	readonly runId: string;
	readonly boundAt: string;
	readonly nodes: readonly PinnedNodeIdentity[];
	readonly runtimes: readonly PinnedRuntimeIdentity[];
	readonly capabilityManifest: PinnedCapabilityManifestIdentity;
	readonly policy: PinnedPolicyIdentity;
	readonly model: PinnedModelConfigurationIdentity;
}

export interface WorkflowBindingCurrent {
	readonly workflow: WorkflowReference;
	readonly nodes: readonly PinnedNodeIdentity[];
	readonly runtimes: readonly PinnedRuntimeIdentity[];
	readonly capabilityManifest: PinnedCapabilityManifestIdentity;
	readonly policy: PinnedPolicyIdentity;
	readonly model: PinnedModelConfigurationIdentity;
}

export type ContractFreshness =
	| "current"
	| "workflow-deleted"
	| "workflow-version-changed"
	| "workflow-source-changed"
	| "workflow-contract-changed";

export interface ContractFreshnessResult {
	readonly status: ContractFreshness;
	readonly changedFields: readonly string[];
}

export class WorkflowBindingResolutionError extends Error {
	readonly reasonCode: BindingReasonCode | "contract-stale";

	constructor(reasonCode: BindingReasonCode | "contract-stale", message: string) {
		super(message);
		this.name = "WorkflowBindingResolutionError";
		this.reasonCode = reasonCode;
	}
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return value;
}

function immutable<T>(value: T): T {
	return deepFreeze(structuredClone(value));
}

function stableValue(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort(compareStrings)
		.map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`)
		.join(",")}}`;
}

function sameScalar(left: unknown, right: unknown): boolean {
	return left === right;
}

function sameRepository(
	left: WorkflowBindingInputs["repository"],
	right: WorkflowBindingSelector["repository"],
): boolean {
	if (!left || !right || left.provider !== right.provider || left.id !== right.id) return false;
	return right.revision === undefined || left.revision === right.revision;
}

function pathUnder(path: string, prefix: string): boolean {
	const normalizedPath = path.replace(/^\/+|\/+$/g, "");
	const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "");
	return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`);
}

function selectorMatches(inputs: WorkflowBindingInputs, selector: WorkflowBindingSelector): boolean {
	if (selector.repository && !sameRepository(inputs.repository, selector.repository)) return false;
	if (selector.taskTypes && (!inputs.taskType || !selector.taskTypes.includes(inputs.taskType))) return false;
	if (selector.labels && (!inputs.labels || selector.labels.some((label) => !inputs.labels?.includes(label))))
		return false;
	if (
		selector.paths &&
		(!inputs.paths || !selector.paths.some((prefix) => inputs.paths?.some((path) => pathUnder(path, prefix))))
	)
		return false;
	if (selector.tenant !== undefined && inputs.tenant !== selector.tenant) return false;
	if (selector.actors && (!inputs.actor || !selector.actors.includes(inputs.actor.id))) return false;
	if (selector.environments && (!inputs.environment || !selector.environments.includes(inputs.environment)))
		return false;
	if (selector.attributes) {
		if (!inputs.attributes) return false;
		for (const [key, value] of Object.entries(selector.attributes)) {
			if (!Object.hasOwn(inputs.attributes, key) || !sameScalar(inputs.attributes[key], value)) return false;
		}
	}
	return true;
}

function selectorSpecificity(selector: WorkflowBindingSelector): number {
	let result = 0;
	if (selector.repository) result += 2 + (selector.repository.revision === undefined ? 0 : 1);
	if (selector.taskTypes) result += 1;
	result += selector.labels?.length ?? 0;
	result += selector.paths?.length ?? 0;
	if (selector.tenant !== undefined) result += 1;
	result += selector.actors?.length ?? 0;
	result += selector.environments?.length ?? 0;
	result += Object.keys(selector.attributes ?? {}).length;
	return result;
}

function sameWorkflow(left: WorkflowReference, right: WorkflowReference): boolean {
	return (
		left.name === right.name &&
		left.version === right.version &&
		left.source.kind === right.source.kind &&
		left.source.id === right.source.id &&
		left.source.digest === right.source.digest &&
		left.source.trusted === right.source.trusted &&
		left.irDigest === right.irDigest
	);
}

function workflowTarget(left: WorkflowReference, right: WorkflowReference): boolean {
	return left.name === right.name && left.version === right.version && left.source.id === right.source.id;
}

function validReference(value: WorkflowReference): boolean {
	const validDigest = (digest: string) =>
		/^sha256:[0-9a-f]{64}$/i.test(digest) || /^sha512:[0-9a-f]{128}$/i.test(digest);
	return value.source.trusted === true && validDigest(value.source.digest) && validDigest(value.irDigest);
}

function normalizeRules(catalog: WorkflowBindingCatalog): WorkflowBindingRules {
	try {
		return parseWorkflowBindingRules(catalog.rules);
	} catch {
		return [];
	}
}

function hasExplicitlyUntrustedRuleSource(catalog: WorkflowBindingCatalog): boolean {
	return (Array.isArray(catalog.rules) ? catalog.rules : []).some((rule) => {
		if (rule === null || typeof rule !== "object") return false;
		const workflow = (rule as { workflow?: unknown }).workflow;
		if (workflow === null || typeof workflow !== "object") return false;
		const source = (workflow as { source?: unknown }).source;
		return source !== null && typeof source === "object" && (source as { trusted?: unknown }).trusted === false;
	});
}

function catalogWorkflow(rule: WorkflowBindingRule, catalog: WorkflowBindingCatalog): WorkflowReference | undefined {
	if (rule.workflow.source.trusted !== true) return undefined;
	if (!catalog.workflows) return rule.workflow;
	return catalog.workflows.find((workflow) => workflowTarget(workflow, rule.workflow));
}

function resolutionExplanation(
	reasonCode: BindingReasonCode,
	message: string,
	matchedRuleIds: readonly string[] = [],
	winningRuleIds: readonly string[] = [],
): BindingExplanation {
	return immutable({
		reasonCode,
		message,
		matchedRuleIds: [...matchedRuleIds].sort(compareStrings),
		winningRuleIds: [...winningRuleIds].sort(compareStrings),
	});
}

export function resolveWorkflowBinding(input: BindingResolutionInput): WorkflowBindingResolution {
	if (hasExplicitlyUntrustedRuleSource(input.catalog)) {
		return immutable({
			status: "denied",
			profile: "strict",
			matchedRules: [],
			explanation: resolutionExplanation(
				"binding-source-untrusted",
				"A binding rule references an explicitly untrusted workflow source.",
			),
		});
	}
	let inputs: WorkflowBindingInputs;
	const rawRules = Array.isArray(input.catalog.rules) ? input.catalog.rules : [];
	const rules = normalizeRules(input.catalog);
	try {
		inputs = parseWorkflowBindingInputs(input.inputs);
	} catch {
		return immutable({
			status: "denied",
			profile: "strict",
			matchedRules: [],
			explanation: resolutionExplanation("binding-rule-invalid", "Binding inputs failed canonical validation."),
		});
	}
	if (rawRules.length === 0 || rules.length !== rawRules.length) {
		return immutable({
			status: "denied",
			profile: "strict",
			matchedRules: [],
			explanation: resolutionExplanation("binding-rule-invalid", "Binding rules failed canonical validation."),
		});
	}

	const matches = rules
		.filter((rule) => selectorMatches(inputs, rule.selector))
		.map((rule) => ({ rule, specificity: selectorSpecificity(rule.selector) }))
		.sort(
			(left, right) =>
				right.rule.priority - left.rule.priority ||
				right.specificity - left.specificity ||
				compareStrings(left.rule.id, right.rule.id),
		);
	const matchedRuleIds = matches.map(({ rule }) => rule.id);
	if (matches.length === 0) {
		return immutable({
			status: "unbound",
			profile: "advisory",
			matchedRules: [],
			explanation: resolutionExplanation("no-binding-match", "No binding rule matched the supplied workflow inputs."),
		});
	}

	const winner = matches[0];
	const tied = matches.filter(
		({ rule, specificity }) => rule.priority === winner.rule.priority && specificity === winner.specificity,
	);
	const conflicting = tied.some(
		({ rule }) => !workflowTarget(rule.workflow, winner.rule.workflow) || rule.profile !== winner.rule.profile,
	);
	if (conflicting && tied.some(({ rule }) => rule.profile === "strict")) {
		return immutable({
			status: "denied",
			profile: "strict",
			matchedRules: matches,
			explanation: resolutionExplanation(
				"strict-binding-ambiguous",
				"Strict policy denied an equal-precedence binding ambiguity.",
				matchedRuleIds,
				tied.map(({ rule }) => rule.id),
			),
		});
	}

	const workflow = catalogWorkflow(winner.rule, input.catalog);
	if (!workflow) {
		const versionUnavailable =
			input.catalog.workflows?.some(
				(candidate) =>
					candidate.name === winner.rule.workflow.name && candidate.source.id === winner.rule.workflow.source.id,
			) ?? false;
		const reasonCode = versionUnavailable ? "binding-source-version-unavailable" : "binding-source-missing";
		return immutable({
			status: "denied",
			profile: winner.rule.profile,
			matchedRules: matches,
			explanation: resolutionExplanation(
				reasonCode,
				`${versionUnavailable ? "Workflow version" : "Trusted workflow source"} for rule ${winner.rule.id} is unavailable.`,
				matchedRuleIds,
				[winner.rule.id],
			),
		});
	}
	if (workflow.source.trusted !== true || winner.rule.workflow.source.trusted !== true) {
		return immutable({
			status: "denied",
			profile: winner.rule.profile,
			matchedRules: matches,
			explanation: resolutionExplanation(
				"binding-source-untrusted",
				`Workflow source for rule ${winner.rule.id} is not trusted.`,
				matchedRuleIds,
				[winner.rule.id],
			),
		});
	}
	if (!workflowTarget(workflow, winner.rule.workflow)) {
		return immutable({
			status: "denied",
			profile: winner.rule.profile,
			matchedRules: matches,
			explanation: resolutionExplanation(
				"binding-source-version-unavailable",
				`Workflow version for rule ${winner.rule.id} is unavailable.`,
				matchedRuleIds,
				[winner.rule.id],
			),
		});
	}
	if (!validReference(workflow) || !sameWorkflow(workflow, winner.rule.workflow)) {
		return immutable({
			status: "denied",
			profile: winner.rule.profile,
			matchedRules: matches,
			explanation: resolutionExplanation(
				"binding-source-version-unavailable",
				`Pinned workflow identity for rule ${winner.rule.id} is not current.`,
				matchedRuleIds,
				[winner.rule.id],
			),
		});
	}

	return immutable({
		status: "resolved",
		profile: winner.rule.profile,
		rule: winner.rule,
		workflow,
		matchedRules: matches,
		explanation: resolutionExplanation(
			"binding-resolved",
			`Rule ${winner.rule.id} selected with priority ${winner.rule.priority} and specificity ${winner.specificity}.`,
			matchedRuleIds,
			[winner.rule.id],
		),
	});
}

export function explainWorkflowBinding(value: WorkflowBindingResolution): string {
	const winning = value.explanation.winningRuleIds.join(", ") || "none";
	return `${value.status}: ${value.explanation.reasonCode}; profile=${value.profile}; matched=${value.explanation.matchedRuleIds.join(", ") || "none"}; winning=${winning}; ${value.explanation.message}`;
}

export function workflowBindingFingerprint(value: WorkflowBindingResolution): string {
	return createHash("sha256").update(stableValue(value)).digest("hex");
}

export function evaluateEnforcementProfile(
	profile: EnforcementProfile,
	input: ProfileEvaluationInput,
): ProfileEvaluation {
	const semantics = enforcementProfileSemantics(profile);
	if (!input.deviation) return { allowed: true, recorded: false, reasonCode: "no-deviation" };
	if (semantics.deviations === "record")
		return { allowed: true, recorded: true, reasonCode: "advisory-recorded", reason: input.reason };
	if (semantics.deviations === "authorized-override" && input.authorizedOverride && input.reason && input.scope)
		return { allowed: true, recorded: true, reasonCode: "guided-override", reason: input.reason };
	return semantics.inRunOverride === "forbidden"
		? { allowed: false, recorded: false, reasonCode: "strict-bypass-denied" }
		: { allowed: false, recorded: false, reasonCode: "guided-override-required" };
}

export function pinWorkflowRunContract(
	resolution: WorkflowBindingResolution,
	input: WorkflowBindingPinInput,
): PinnedWorkflowRunContract {
	if (resolution.status !== "resolved" || !resolution.rule || !resolution.workflow)
		throw new WorkflowBindingResolutionError("binding-source-missing", "Only a resolved binding can be pinned.");
	return parsePinnedWorkflowRunContract({
		version: "1",
		runId: input.runId,
		profile: resolution.profile,
		bindingRuleId: resolution.rule.id,
		boundAt: input.boundAt,
		workflow: resolution.workflow,
		nodes: input.nodes,
		runtimes: input.runtimes,
		capabilityManifest: input.capabilityManifest,
		policy: input.policy,
		model: input.model,
	});
}

export function compareWorkflowContract(
	contract: PinnedWorkflowRunContract,
	current: WorkflowBindingCurrent | undefined,
): ContractFreshnessResult {
	if (!current) return { status: "workflow-deleted", changedFields: ["workflow"] };
	if (current.workflow.name !== contract.workflow.name || current.workflow.version !== contract.workflow.version) {
		return {
			status: "workflow-version-changed",
			changedFields: [
				...(current.workflow.name !== contract.workflow.name ? ["workflow.name"] : []),
				...(current.workflow.version !== contract.workflow.version ? ["workflow.version"] : []),
			],
		};
	}
	if (
		current.workflow.source.trusted !== true ||
		current.workflow.source.kind !== contract.workflow.source.kind ||
		current.workflow.source.id !== contract.workflow.source.id ||
		current.workflow.source.digest !== contract.workflow.source.digest ||
		current.workflow.irDigest !== contract.workflow.irDigest
	)
		return { status: "workflow-source-changed", changedFields: ["workflow.source", "workflow.irDigest"] };
	const fields: Array<[string, unknown, unknown]> = [
		["nodes", current.nodes, contract.nodes],
		["runtimes", current.runtimes, contract.runtimes],
		["capabilityManifest", current.capabilityManifest, contract.capabilityManifest],
		["policy", current.policy, contract.policy],
		["model", current.model, contract.model],
	];
	const changedFields = fields
		.filter(([, left, right]) => stableValue(left) !== stableValue(right))
		.map(([name]) => name);
	return changedFields.length === 0
		? { status: "current", changedFields: [] }
		: { status: "workflow-contract-changed", changedFields };
}

export function assertWorkflowContractCurrent(
	contract: PinnedWorkflowRunContract,
	current: WorkflowBindingCurrent | undefined,
): void {
	const result = compareWorkflowContract(contract, current);
	if (result.status !== "current")
		throw new WorkflowBindingResolutionError(
			"contract-stale",
			`Pinned workflow contract is ${result.status}: ${result.changedFields.join(", ")}.`,
		);
}

export class InMemoryWorkflowBindingProvider {
	private catalog: WorkflowBindingCatalog;

	constructor(catalog: WorkflowBindingCatalog) {
		this.catalog = this.snapshot(catalog);
	}

	private snapshot(catalog: WorkflowBindingCatalog): WorkflowBindingCatalog {
		const rules = [...parseWorkflowBindingRules(catalog.rules)].sort(
			(left, right) => right.priority - left.priority || compareStrings(left.id, right.id),
		);
		const workflows = catalog.workflows
			? [...catalog.workflows].sort((left, right) => compareStrings(stableValue(left), stableValue(right)))
			: undefined;
		return immutable({ rules, ...(workflows ? { workflows } : {}) });
	}

	getCatalog(): WorkflowBindingCatalog {
		return this.catalog;
	}
	replace(catalog: WorkflowBindingCatalog): void {
		this.catalog = this.snapshot(catalog);
	}
	resolve(inputs: WorkflowBindingInputs): WorkflowBindingResolution {
		return resolveWorkflowBinding({ inputs, catalog: this.catalog });
	}
	explain(inputs: WorkflowBindingInputs): string {
		return explainWorkflowBinding(this.resolve(inputs));
	}
}

export { ENFORCEMENT_PROFILES };
