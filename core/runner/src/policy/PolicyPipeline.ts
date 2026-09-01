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
	type SecretLease,
	type SecretRef,
	type SecretRequest,
	type SecretResolutionAuditEvent,
	type SecretResolutionFailure,
	type SecretResolver,
	type SessionIdentity,
	type StepIdentity,
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
	secretResolver?: SecretResolver;
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
const authorizedSecrets = new WeakMap<Context, ReadonlySet<string>>();
const activeSteps = new WeakMap<Context, StepIdentity>();

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
	authorizedSecrets.delete(ctx);
	// Agent execution must not inherit the ambient process environment. Keep
	// this as an own property so the ABI remains unchanged for ordinary runs.
	if (Object.getOwnPropertyDescriptor(ctx, "env")?.configurable) {
		Object.defineProperty(ctx, "env", { value: Object.freeze({}), enumerable: true, configurable: true });
	}
}
export function propagatePolicyExecution(parent: Context, child: Context): void {
	const state = states.get(parent);
	if (state) {
		states.set(child, state);
		const secrets = authorizedSecrets.get(parent);
		if (secrets) authorizedSecrets.set(child, secrets);
		const step = activeSteps.get(parent);
		if (step) activeSteps.set(child, step);
	}
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
	return {
		effects: manifest?.effects ?? [],
		capabilities: manifest?.capabilities ?? [],
		secrets: manifest?.secrets ?? [],
		fragments: {},
	};
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
	if (!state.secretResolver && (node.capabilityManifest?.secrets.length ?? 0) > 0)
		throw new PolicyDeniedError("missing-secret-resolver");
	const assessment = assessCapabilityManifest(node.capabilityManifestRaw ?? node.capabilityManifest);
	if (!assessment.agentEligible || !assessment.manifest)
		throw new CapabilityManifestError([`agent execution requires an eligible manifest (${assessment.reason})`]);
	const request = requestFor(ctx, node, attempt, ctx.signal);
	activeSteps.set(ctx, request.step);
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
	if (request.scope.secrets.length > 0) authorizedSecrets.set(ctx, new Set(request.scope.secrets));
	return { request, result, correlationId, startedAt: performance.now(), cached };
}

/**
 * Re-authorize a persisted interaction request without manufacturing a new
 * request id or changing its policy scope. Control-plane resume code injects
 * this function into InteractionResumeCoordinator before it invokes the
 * continuation that owns workflow/cursor rehydration.
 */
export async function reauthorizePolicyRequest(ctx: Context, request: PolicyRequest): Promise<void> {
	const state = states.get(ctx);
	if (!state) throw new PolicyDeniedError("missing-security-state");
	if (request.origin !== "agent") throw new PolicyDeniedError("invalid-interaction-origin");
	if (request.principal?.id !== state.principal.id) throw new PolicyDeniedError("interaction-principal-mismatch");
	if (request.session?.id !== state.session.id) throw new PolicyDeniedError("interaction-session-mismatch");
	if (request.turn?.id !== state.turn.id) throw new PolicyDeniedError("interaction-turn-mismatch");
	if (request.workflow.name !== (ctx.workflow_name ?? "<unknown>"))
		throw new PolicyDeniedError("interaction-workflow-mismatch");
	if (ctx.signal?.aborted || request.signal?.aborted) throw new PolicyDeniedError("cancelled");

	let timer: ReturnType<typeof setTimeout> | undefined;
	let abortHandler: (() => void) | undefined;
	const cancellation = new Promise<never>((_, reject) => {
		const signal = ctx.signal ?? request.signal;
		if (signal?.aborted) reject(new PolicyDeniedError("cancelled"));
		else if (signal) {
			abortHandler = () => reject(new PolicyDeniedError("cancelled"));
			signal.addEventListener("abort", abortHandler, { once: true });
		}
	});
	let result: PolicyEvaluationResult;
	try {
		result = await Promise.race([
			state.provider.evaluate(request),
			cancellation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new PolicyDeniedError("policy-timeout")), 5000);
			}),
		]);
	} catch (error) {
		throw error instanceof PolicyDeniedError ? error : new PolicyDeniedError("policy-provider-failure");
	} finally {
		if (timer) clearTimeout(timer);
		if (abortHandler) (ctx.signal ?? request.signal)?.removeEventListener("abort", abortHandler);
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
	try {
		await state.auditSink.append(
			auditBase(request, result, correlationId, false, "policy.pre") as PreExecutionAuditEvent,
		);
	} catch (error) {
		throw new PolicyAuditError(`pre-execution audit failed: ${String(error)}`, false);
	}
	if (result.decision.kind === "deny")
		throw new PolicyDeniedError(result.decision.reasonCode, result.decision.reason ?? result.decision.reasonCode);
	if (result.decision.kind === "ask") throw new PolicyDeniedError("interaction-required");
	if (
		result.decision.kind === "require-sandbox" &&
		(!result.sandbox || !state.sandboxVerifier || !(await state.sandboxVerifier.verify(result.sandbox, request)))
	) {
		throw new PolicyDeniedError("invalid-sandbox-attestation");
	}
}

export class SecretResolutionError extends Error {
	readonly code: SecretResolutionFailure;
	constructor(code: SecretResolutionFailure) {
		super(code);
		this.name = "SecretResolutionError";
		this.code = code;
	}
}

const SECRET_NAME = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/;
function validSecretRef(reference: SecretRef): boolean {
	return reference.version === "1" && SECRET_NAME.test(reference.name);
}

function secretRequest(ctx: Context, reference: SecretRef): SecretRequest {
	const state = states.get(ctx);
	if (!state) throw new SecretResolutionError("SECRET_NOT_AUTHORIZED");
	const step = activeSteps.get(ctx) ?? { id: "unknown" };
	return {
		requestId: uuid(),
		origin: "agent",
		principal: state.principal,
		session: state.session,
		turn: state.turn,
		workflow: { name: ctx.workflow_name ?? "<unknown>" },
		step,
		manifest: null,
		scope: { effects: ["secret"], capabilities: ["secret.resolve"], secrets: [reference.name], fragments: {} },
		layers: state.layers ?? [],
		signal: ctx.signal,
		reference,
	};
}

export async function resolveSecret(ctx: Context, reference: SecretRef): Promise<SecretLease> {
	if (!validSecretRef(reference)) throw new SecretResolutionError("SECRET_NOT_AUTHORIZED");
	const state = states.get(ctx);
	if (!state?.secretResolver || !authorizedSecrets.get(ctx)?.has(reference.name))
		throw new SecretResolutionError("SECRET_NOT_AUTHORIZED");
	if (ctx.signal?.aborted) throw new SecretResolutionError("SECRET_RESOLVER_UNAVAILABLE");
	const request = secretRequest(ctx, reference);
	const correlationId = uuid();
	try {
		const lease = await state.secretResolver.resolve(request);
		const event: SecretResolutionAuditEvent = {
			version: "1",
			eventType: "secret.resolve",
			eventId: uuid(),
			timestamp: new Date().toISOString(),
			correlationId,
			principalId: request.principal?.id,
			sessionId: request.session?.id,
			turnId: request.turn?.id,
			workflow: request.workflow,
			step: request.step,
			reference,
			leaseId: lease.leaseId,
			outcome: "success",
			redaction: { redacted: true, fields: ["value"] },
		};
		await state.auditSink.append(event);
		return lease;
	} catch (error) {
		const code = error instanceof SecretResolutionError ? error.code : "SECRET_RESOLVER_UNAVAILABLE";
		try {
			await state.auditSink.append({
				version: "1",
				eventType: "secret.resolve",
				eventId: uuid(),
				timestamp: new Date().toISOString(),
				correlationId,
				principalId: request.principal?.id,
				sessionId: request.session?.id,
				turnId: request.turn?.id,
				workflow: request.workflow,
				step: request.step,
				reference,
				outcome: "failure",
				errorCode: code,
				redaction: { redacted: true, fields: ["value"] },
			} satisfies SecretResolutionAuditEvent);
		} catch {
			throw new PolicyAuditError("secret-resolution audit failed", false);
		}
		throw error instanceof SecretResolutionError ? error : new SecretResolutionError(code);
	}
}

export class InMemorySecretResolver implements SecretResolver {
	private readonly values: ReadonlyMap<string, string>;
	private readonly revoked = new Set<string>();
	constructor(values: ReadonlyMap<string, string> | Record<string, string>) {
		this.values = values instanceof Map ? new Map(values) : new Map(Object.entries(values));
	}
	revoke(name: string): void {
		this.revoked.add(name);
	}
	async resolve(request: SecretRequest): Promise<SecretLease> {
		if (this.revoked.has(request.reference.name)) throw new SecretResolutionError("SECRET_REVOKED");
		const value = this.values.get(request.reference.name);
		if (value === undefined) throw new SecretResolutionError("SECRET_NOT_FOUND");
		const expiresAtMs = Date.now() + 60_000;
		const expiresAt = new Date(expiresAtMs).toISOString();
		return {
			reference: request.reference,
			leaseId: uuid(),
			expiresAt,
			read: () => {
				if (Date.now() >= expiresAtMs) throw new SecretResolutionError("SECRET_EXPIRED");
				if (this.revoked.has(request.reference.name)) throw new SecretResolutionError("SECRET_REVOKED");
				return value;
			},
		};
	}
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
	private readonly events: Array<PreExecutionAuditEvent | PostExecutionAuditEvent | SecretResolutionAuditEvent> = [];
	async append(event: PreExecutionAuditEvent | PostExecutionAuditEvent | SecretResolutionAuditEvent): Promise<void> {
		this.events.push(Object.freeze(structuredClone(event)));
	}
	read(): readonly (PreExecutionAuditEvent | PostExecutionAuditEvent | SecretResolutionAuditEvent)[] {
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
