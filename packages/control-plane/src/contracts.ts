import type { AgentSessionEvent, InteractionPayload, SessionJsonValue, SessionState } from "@blokjs/shared";
import { z } from "zod";

export const CONTROL_PLANE_CONTRACT_VERSION = "1" as const;
export const CONTROL_PLANE_SUPPORTED_VERSIONS = [CONTROL_PLANE_CONTRACT_VERSION] as const;
export const CONTROL_PLANE_MAX_REQUEST_BYTES = 64 * 1024;
export const CONTROL_PLANE_MAX_RESPONSE_BYTES = 64 * 1024;
export const CONTROL_PLANE_MAX_EVENT_BYTES = 64 * 1024;
export const CONTROL_PLANE_MAX_METADATA_ENTRIES = 32;
export const CONTROL_PLANE_MAX_METADATA_VALUE_LENGTH = 256;
export const CONTROL_PLANE_DEFAULT_PAGE_SIZE = 128;
export const CONTROL_PLANE_MAX_PAGE_SIZE = 256;

export type ControlPlaneOperation =
	| "create-session"
	| "open-session"
	| "fork-session"
	| "inspect-session"
	| "submit-turn"
	| "steer-turn"
	| "start-workflow"
	| "stream-events"
	| "answer-interaction"
	| "resolve-approval"
	| "cancel"
	| "resume";

export const CONTROL_PLANE_OPERATIONS: readonly ControlPlaneOperation[] = [
	"create-session",
	"open-session",
	"fork-session",
	"inspect-session",
	"submit-turn",
	"steer-turn",
	"start-workflow",
	"stream-events",
	"answer-interaction",
	"resolve-approval",
	"cancel",
	"resume",
];

export type ControlPlaneStatus = "ok" | "accepted" | "not-ready";

export interface ControlPlaneEndpoint {
	readonly address: string;
	readonly port: number;
	readonly token: string;
	readonly contractVersion: typeof CONTROL_PLANE_CONTRACT_VERSION;
}

export interface ControlPlaneCapabilities {
	readonly contractVersion: typeof CONTROL_PLANE_CONTRACT_VERSION;
	readonly supportedVersions: readonly string[];
	readonly operations: readonly ControlPlaneOperation[];
	readonly maxRequestBytes: number;
	readonly maxResponseBytes: number;
	readonly maxEventBytes: number;
	readonly supportsCursorResume: boolean;
	readonly supportsAuthentication: boolean;
	readonly supportsDeadlines: boolean;
	readonly supportsCancellation: boolean;
}

export interface CreateSessionRequest {
	readonly sessionId?: string;
	readonly principalId?: string;
	readonly metadata?: Readonly<Record<string, string>>;
}

export interface OpenSessionRequest {
	readonly sessionId: string;
}

export interface ForkSessionRequest {
	readonly parentSessionId: string;
	readonly parentSequence: number;
	readonly sessionId?: string;
}

export interface SubmitTurnRequest {
	readonly content: SessionJsonValue;
	readonly turnId?: string;
}

export interface SteerTurnRequest {
	readonly turnId: string;
	readonly content: SessionJsonValue;
}

export interface StartWorkflowRequest {
	readonly workflowName: string;
	readonly input?: SessionJsonValue;
	readonly workflowRunId?: string;
}

export interface StreamEventsRequest {
	readonly sessionId: string;
	readonly afterSequence?: number;
	readonly limit?: number;
	readonly follow?: boolean;
}

export interface AnswerInteractionRequest {
	readonly interactionId: string;
	readonly sequence: number;
	readonly answer?: InteractionPayload;
	readonly deny?: boolean;
}

export interface ResumeRequest {
	readonly interactionId: string;
	readonly sequence: number;
}

export type CancellationTarget = "session" | "turn" | "workflow";

export interface CancelRequest {
	readonly target: CancellationTarget;
	readonly targetId?: string;
	readonly reason?: string;
}

export interface SessionResponse {
	readonly sessionId: string;
	readonly state?: SessionState;
	readonly created?: boolean;
	readonly forkedFrom?: { readonly sessionId: string; readonly sequence: number };
}

export interface TurnResponse {
	readonly sessionId: string;
	readonly turnId: string;
	readonly accepted: true;
}

export interface WorkflowResponse {
	readonly sessionId: string;
	readonly workflowRunId: string;
	readonly accepted: true;
}

export interface InteractionResponse {
	readonly interactionId: string;
	readonly status: string;
	readonly sequence: number;
}

export interface CancelResponse {
	readonly cancelled: true;
	readonly target: CancellationTarget;
	readonly targetId?: string;
}

export interface ResumeResponse {
	readonly interactionId: string;
	readonly resumed: true;
	readonly sequence: number;
}

export class ControlPlaneContractError extends Error {
	readonly code = "CONTROL_PLANE_INVALID" as const;

	constructor(message: string) {
		super(message);
		this.name = "ControlPlaneContractError";
	}
}

const identifier = z.string().min(1).max(256);
const jsonValue: z.ZodType<SessionJsonValue> = z.lazy(() =>
	z.union([
		z.string().max(8 * 1024),
		z.number().finite(),
		z.boolean(),
		z.null(),
		z.array(jsonValue).max(256),
		z.record(jsonValue).refine((value) => Object.keys(value).length <= 256),
	]),
);

export const createSessionRequestSchema = z
	.object({
		sessionId: identifier.optional(),
		principalId: identifier.optional(),
		metadata: z
			.record(z.string().max(256))
			.refine((value) => Object.keys(value).length <= CONTROL_PLANE_MAX_METADATA_ENTRIES)
			.optional(),
	})
	.strict();
export const openSessionRequestSchema = z.object({ sessionId: identifier }).strict();
export const forkSessionRequestSchema = z
	.object({
		parentSessionId: identifier,
		parentSequence: z.number().int().nonnegative().safe(),
		sessionId: identifier.optional(),
	})
	.strict();
export const submitTurnRequestSchema = z.object({ content: jsonValue, turnId: identifier.optional() }).strict();
export const steerTurnRequestSchema = z.object({ turnId: identifier, content: jsonValue }).strict();
export const startWorkflowRequestSchema = z
	.object({ workflowName: identifier, input: jsonValue.optional(), workflowRunId: identifier.optional() })
	.strict();
export const streamEventsRequestSchema = z
	.object({
		sessionId: identifier,
		afterSequence: z.number().int().nonnegative().safe().optional(),
		limit: z.number().int().positive().max(CONTROL_PLANE_MAX_PAGE_SIZE).optional(),
		follow: z.boolean().optional(),
	})
	.strict();
export const answerInteractionRequestSchema = z
	.object({
		interactionId: identifier,
		sequence: z.number().int().nonnegative().safe(),
		answer: z.unknown().optional(),
		deny: z.boolean().optional(),
	})
	.strict();
export const resumeRequestSchema = z
	.object({ interactionId: identifier, sequence: z.number().int().nonnegative().safe() })
	.strict();
export const cancelRequestSchema = z
	.object({
		target: z.enum(["session", "turn", "workflow"]),
		targetId: identifier.optional(),
		reason: z.string().max(1024).optional(),
	})
	.strict();

export function parseRequest<T>(
	schema: z.ZodType<T, z.ZodTypeDef, unknown>,
	value: unknown,
	operation: ControlPlaneOperation,
): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw new ControlPlaneContractError(`${operation} request is invalid: ${parsed.error.message}`);
	return parsed.data;
}

export function parseInteractionAnswerPayload(value: unknown): InteractionPayload | undefined {
	if (value === undefined) return undefined;
	const parsed = jsonValue.safeParse(value);
	if (!parsed.success) throw new ControlPlaneContractError(`answer payload is invalid: ${parsed.error.message}`);
	assertJsonSize(parsed.data, 64 * 1024, "answer payload");
	return parsed.data;
}

export function ensureSupportedVersion(value: unknown): asserts value is typeof CONTROL_PLANE_CONTRACT_VERSION {
	if (value !== CONTROL_PLANE_CONTRACT_VERSION)
		throw new ControlPlaneContractError("unsupported control-plane contract version");
}

export function assertJsonSize(value: unknown, maxBytes: number, label: string): void {
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new ControlPlaneContractError(`${label} must be JSON serializable`);
	}
	if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > maxBytes)
		throw new ControlPlaneContractError(`${label} exceeds ${maxBytes} bytes`);
}

export function eventByteSize(event: AgentSessionEvent): number {
	const serialized = JSON.stringify(event);
	return new TextEncoder().encode(serialized).byteLength;
}
