import {
	type AuditSink,
	CapabilityManifestError,
	type Context,
	type InteractionSuspensionPort,
	type NodeBase,
	type PolicyEvaluationResult,
	type PolicyLayer,
	type PolicyLayerName,
	type PolicyProvider,
	type PolicyRequest,
	type PolicyRuleMatch,
	type PostExecutionAuditEvent,
	type PreExecutionAuditEvent,
	type PrincipalIdentity,
	type RequestedCapabilityScope,
	type SandboxAttestation,
	type SessionIdentity,
	type TurnIdentity,
	type WorkflowIdentity,
	assessCapabilityManifest,
} from "@blokjs/shared";
import { v4 as uuid } from "uuid";

export interface SandboxVerifier {
	verify(attestation: SandboxAttestation, request: PolicyRequest): Promise<boolean>;
}
export interface PolicyExecutionOptions {
	principal: PrincipalIdentity;
	session: SessionIdentity;
	turn: TurnIdentity;
	policyVersion: string;
	provider: PolicyProvider;
	auditSink: AuditSink;
	interaction?: InteractionSuspensionPort;
	sandboxVerifier?: SandboxVerifier;
	layers?: readonly PolicyLayer[];
}
interface PolicyState extends PolicyExecutionOptions {
	origin: "agent";
}
export interface PolicyToken {
	request: PolicyRequest;
	result: PolicyEvaluationResult;
	correlationId: string;
	startedAt: number;
	cached: boolean;
}
const states = new WeakMap<Context, PolicyState>();

export class PolicyDeniedError extends Error {
	readonly code = "POLICY_DENIED";
	constructor(
		public readonly reasonCode: string,
		message = reasonCode,
	) {
		super(message);
		this.name = "PolicyDeniedError";
	}
}
export class PolicyInteractionRequiredError extends Error {
	readonly code = "POLICY_INTERACTION_REQUIRED";
	constructor(public readonly requestId: string) {
		super(`Policy interaction required: ${requestId}`);
		this.name = "PolicyInteractionRequiredError";
	}
}
export class PolicyAuditError extends Error {
	readonly code = "POLICY_AUDIT_FAILED";
	constructor(
		message: string,
		public readonly afterExecution: boolean,
	) {
		super(message);
		this.name = "PolicyAuditError";
	}
}

export function installPolicyExecution(ctx: Context, options: PolicyExecutionOptions): void {
	if (
		!options.principal?.id ||
		!options.session?.id ||
		!options.turn?.id ||
		!options.policyVersion ||
		!options.provider ||
		!options.auditSink
	) {
		throw new PolicyDeniedError("missing-security-state");
	}
	states.set(ctx, { ...options, origin: "agent", layers: normalizeLayers(options.layers) });
}
export function propagatePolicyExecution(parent: Context, child: Context): void {
	const state = states.get(parent);
	if (state) states.set(child, state);
}
export function hasPolicyExecution(ctx: Context): boolean {
	return states.has(ctx);
}

function normalizeLayers(layers: readonly PolicyLayer[] | undefined): readonly PolicyLayer[] {
	const order = ["deployment", "repository", "workflow", "phase", "user"] as const;
	const supplied = layers ?? [];
	return [...supplied].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
}
function scopeFor(node: NodeBase): RequestedCapabilityScope {
	const manifest = node.capabilityManifest;
	return { effects: manifest?.effects ?? [], capabilities: manifest?.capabilities ?? [], fragments: {} };
}
function requestFor(ctx: Context, node: NodeBase, attempt: number, signal?: AbortSignal): PolicyRequest {
	const state = states.get(ctx);
	if (!state) throw new PolicyDeniedError("missing-security-state");
	const workflow: WorkflowIdentity = { name: ctx.workflow_name ?? "<unknown>" };
	return {
		requestId: uuid(),
		origin: "agent",
		principal: state.principal,
		session: state.session,
		turn: state.turn,
		workflow,
		step: { id: node.name, attempt },
		manifest: node.capabilityManifest ?? null,
		scope: scopeFor(node),
		layers: state.layers ?? [],
		signal,
	};
}
function bounded(value: string | undefined, max = 256): string | undefined {
	return value === undefined ? undefined : value.slice(0, max);
}
function auditBase(
	request: PolicyRequest,
	result: PolicyEvaluationResult,
	correlationId: string,
	cached: boolean,
	type: "policy.pre" | "policy.post",
) {
	return {
		version: "1" as const,
		eventType: type,
		eventId: uuid(),
		timestamp: new Date().toISOString(),
		correlationId,
		decisionId: result.decision.id,
		principalId: request.principal?.id,
		sessionId: request.session?.id,
		turnId: request.turn?.id,
		workflow: request.workflow,
		step: request.step,
		attempt: request.step.attempt ?? 1,
		manifest: request.manifest,
		scope: request.scope,
		layers: request.layers,
		matchedRules: result.matchedRules
			.slice(0, 32)
			.map((rule: PolicyRuleMatch) => ({ ...rule, ruleId: bounded(rule.ruleId) })),
		decision: {
			...result.decision,
			reason: bounded(result.decision.reason),
			reasonCode: bounded(result.decision.reasonCode) ?? "unknown",
		},
		sandbox: {
			required: result.decision.kind === "require-sandbox",
			verified: result.decision.kind !== "require-sandbox",
		},
		cached,
		redaction: {
			redacted: true,
			truncated: result.matchedRules.length > 32,
			fields: ["scope.fragments", "secret-like-values"],
		},
	};
}

export async function authorizeStep(
	ctx: Context,
	node: NodeBase,
	attempt: number,
	cached = false,
): Promise<PolicyToken | null> {
	const state = states.get(ctx);
	if (!state) return null;
	if (ctx.signal?.aborted) throw new PolicyDeniedError("cancelled");
	const assessment = assessCapabilityManifest(node.capabilityManifestRaw ?? node.capabilityManifest);
	if (!assessment.agentEligible || !assessment.manifest)
		throw new CapabilityManifestError([`agent execution requires an eligible manifest (${assessment.reason})`]);
	const request = requestFor(ctx, node, attempt, ctx.signal);
	let result: PolicyEvaluationResult;
	try {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abortHandler: (() => void) | undefined;
		const cancellation = new Promise<never>((_, reject) => {
			if (request.signal?.aborted) reject(new PolicyDeniedError("cancelled"));
			else {
				abortHandler = () => reject(new PolicyDeniedError("cancelled"));
				request.signal?.addEventListener("abort", abortHandler, { once: true });
			}
		});
		try {
			result = await Promise.race([
				state.provider.evaluate(request),
				cancellation,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new PolicyDeniedError("policy-timeout")), 5000);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
			if (abortHandler) request.signal?.removeEventListener("abort", abortHandler);
		}
	} catch (error) {
		throw error instanceof PolicyDeniedError ? error : new PolicyDeniedError("policy-provider-failure");
	}
	if (
		!result ||
		!result.decision ||
		result.decision.policyVersion !== state.policyVersion ||
		!["allow", "deny", "ask", "require-sandbox"].includes(result.decision.kind) ||
		!result.decision.id ||
		!result.decision.reasonCode
	) {
		throw new PolicyDeniedError("malformed-policy-result");
	}
	const correlationId = uuid();
	const pre = auditBase(request, result, correlationId, cached, "policy.pre") as PreExecutionAuditEvent;
	try {
		await state.auditSink.append(pre);
	} catch (error) {
		throw new PolicyAuditError(`pre-execution audit failed: ${String(error)}`, false);
	}
	if (result.decision.kind === "deny")
		throw new PolicyDeniedError(result.decision.reasonCode, result.decision.reason ?? result.decision.reasonCode);
	if (result.decision.kind === "ask") {
		if (!state.interaction) throw new PolicyDeniedError("missing-interaction-port");
		await state.interaction.suspend({ id: request.requestId, decision: result.decision, request });
		throw new PolicyInteractionRequiredError(request.requestId);
	}
	if (result.decision.kind === "require-sandbox") {
		if (!result.sandbox || !state.sandboxVerifier || !(await state.sandboxVerifier.verify(result.sandbox, request)))
			throw new PolicyDeniedError("invalid-sandbox-attestation");
	}
	if (ctx.signal?.aborted) throw new PolicyDeniedError("cancelled");
	return { request, result, correlationId, startedAt: performance.now(), cached };
}
export async function recordPostExecution(
	ctx: Context,
	token: PolicyToken | null,
	outcome: "success" | "failure" | "cancelled",
	errorCode?: string,
): Promise<void> {
	if (!token) return;
	const state = states.get(ctx);
	if (!state) throw new PolicyAuditError("policy state disappeared after execution", true);
	const event = {
		...auditBase(token.request, token.result, token.correlationId, token.cached, "policy.post"),
		durationMs: performance.now() - token.startedAt,
		outcome,
		...(errorCode ? { errorCode: bounded(errorCode) } : {}),
	} as PostExecutionAuditEvent;
	try {
		await state.auditSink.append(event);
	} catch (error) {
		throw new PolicyAuditError(`post-execution audit failed: ${String(error)}`, true);
	}
}

export class InMemoryAuditSink implements AuditSink {
	private readonly events: Array<PreExecutionAuditEvent | PostExecutionAuditEvent> = [];
	async append(event: PreExecutionAuditEvent | PostExecutionAuditEvent): Promise<void> {
		this.events.push(Object.freeze(structuredClone(event)));
	}
	read(): readonly (PreExecutionAuditEvent | PostExecutionAuditEvent)[] {
		return this.events.map((event) => structuredClone(event));
	}
}
export class InMemoryPolicyProvider implements PolicyProvider {
	private readonly evaluateRequest?: (
		request: PolicyRequest,
	) => PolicyEvaluationResult | Promise<PolicyEvaluationResult>;
	private readonly evaluators?: Partial<
		Record<PolicyLayerName, (request: PolicyRequest) => PolicyEvaluationResult | Promise<PolicyEvaluationResult>>
	>;
	constructor(
		evaluate:
			| ((request: PolicyRequest) => PolicyEvaluationResult | Promise<PolicyEvaluationResult>)
			| Partial<
					Record<PolicyLayerName, (request: PolicyRequest) => PolicyEvaluationResult | Promise<PolicyEvaluationResult>>
			  >,
	) {
		if (typeof evaluate === "function") this.evaluateRequest = evaluate;
		else this.evaluators = evaluate;
	}
	async evaluate(request: PolicyRequest): Promise<PolicyEvaluationResult> {
		if (this.evaluateRequest) return await this.evaluateRequest(request);
		let decision: PolicyEvaluationResult = {
			decision: { kind: "allow", id: uuid(), reasonCode: "no-rule", policyVersion: request.layers[0]?.version ?? "" },
			matchedRules: [],
		};
		for (const layer of request.layers) {
			const evaluate = this.evaluators?.[layer.name];
			if (!evaluate) continue;
			const next = await evaluate(request);
			if (!next?.decision || next.decision.policyVersion !== layer.version)
				throw new PolicyDeniedError("malformed-policy-result");
			const rank = (kind: string): number =>
				kind === "deny" ? 3 : kind === "require-sandbox" ? 2 : kind === "ask" ? 1 : 0;
			const selected = rank(next.decision.kind) >= rank(decision.decision.kind) ? next : decision;
			decision = { ...selected, matchedRules: [...decision.matchedRules, ...next.matchedRules] };
			if (next.decision.kind === "deny") break;
		}
		return decision;
	}
}
