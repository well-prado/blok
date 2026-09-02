import { randomUUID } from "node:crypto";
import type { SessionJsonValue } from "@blokjs/shared";
import {
	type CallOptions,
	type Client,
	type ClientReadableStream,
	type ClientUnaryCall,
	Metadata,
	type ServiceError,
	credentials,
} from "@grpc/grpc-js";
import {
	type AnswerInteractionRequest,
	CONTROL_PLANE_CONTRACT_VERSION,
	CONTROL_PLANE_DEFAULT_PAGE_SIZE,
	CONTROL_PLANE_MAX_EVENT_BYTES,
	CONTROL_PLANE_MAX_REQUEST_BYTES,
	CONTROL_PLANE_MAX_RESPONSE_BYTES,
	CONTROL_PLANE_SUPPORTED_VERSIONS,
	type CancelRequest,
	type CancelResponse,
	type ControlPlaneCapabilities,
	ControlPlaneContractError,
	type ControlPlaneEndpoint,
	type CreateSessionRequest,
	type ForkSessionRequest,
	type InteractionResponse,
	type OpenSessionRequest,
	type ResumeRequest,
	type ResumeResponse,
	type SessionResponse,
	type StartWorkflowRequest,
	type SteerTurnRequest,
	type StreamEventsRequest,
	type SubmitTurnRequest,
	type TurnResponse,
	type WorkflowResponse,
	assertJsonSize,
} from "./contracts";
import {
	type ProtoCapabilitiesResponse,
	type ProtoEventEnvelope,
	type ProtoHealthRequest,
	type ProtoHealthResponse,
	type ProtoRequestEnvelope,
	type ProtoResponseEnvelope,
	type ProtoStreamEventsRequest,
	getHarnessControlPlaneClientConstructor,
} from "./proto";

export interface ControlPlaneClientOptions {
	readonly endpoint: ControlPlaneEndpoint | { readonly address: string; readonly port: number; readonly token: string };
	readonly defaultDeadlineMs?: number;
	readonly principalId?: string;
	readonly client?: Client;
}

export interface ControlPlaneEvent {
	readonly contractVersion: typeof CONTROL_PLANE_CONTRACT_VERSION;
	readonly sessionId: string;
	readonly sequence: number;
	readonly eventId: string;
	readonly turnId?: string;
	readonly kind: string;
	readonly visibility: string;
	readonly payload: SessionJsonValue;
	readonly occurredAt: string;
	readonly replayed: boolean;
	readonly terminal: boolean;
}

export interface StreamEventsOptions {
	readonly signal?: AbortSignal;
	readonly reconnect?: boolean;
	readonly maxReconnects?: number;
}

interface GeneratedHarnessClient {
	getCapabilities(
		request: Record<string, never>,
		metadata: Metadata,
		options: CallOptions,
		callback: UnaryCallback<ProtoCapabilitiesResponse>,
	): ClientUnaryCall;
	health(
		request: ProtoHealthRequest,
		metadata: Metadata,
		options: CallOptions,
		callback: UnaryCallback<ProtoHealthResponse>,
	): ClientUnaryCall;
	readiness(
		request: ProtoHealthRequest,
		metadata: Metadata,
		options: CallOptions,
		callback: UnaryCallback<ProtoHealthResponse>,
	): ClientUnaryCall;
	createSession(
		request: ProtoRequestEnvelope,
		metadata: Metadata,
		options: CallOptions,
		callback: UnaryCallback<ProtoResponseEnvelope>,
	): ClientUnaryCall;
	openSession(
		request: ProtoRequestEnvelope,
		metadata: Metadata,
		options: CallOptions,
		callback: UnaryCallback<ProtoResponseEnvelope>,
	): ClientUnaryCall;
	forkSession(
		request: ProtoRequestEnvelope,
		metadata: Metadata,
		options: CallOptions,
		callback: UnaryCallback<ProtoResponseEnvelope>,
	): ClientUnaryCall;
	inspectSession(
		request: ProtoRequestEnvelope,
		metadata: Metadata,
		options: CallOptions,
		callback: UnaryCallback<ProtoResponseEnvelope>,
	): ClientUnaryCall;
	submitTurn(
		request: ProtoRequestEnvelope,
		metadata: Metadata,
		options: CallOptions,
		callback: UnaryCallback<ProtoResponseEnvelope>,
	): ClientUnaryCall;
	steerTurn(
		request: ProtoRequestEnvelope,
		metadata: Metadata,
		options: CallOptions,
		callback: UnaryCallback<ProtoResponseEnvelope>,
	): ClientUnaryCall;
	startWorkflow(
		request: ProtoRequestEnvelope,
		metadata: Metadata,
		options: CallOptions,
		callback: UnaryCallback<ProtoResponseEnvelope>,
	): ClientUnaryCall;
	answerInteraction(
		request: ProtoRequestEnvelope,
		metadata: Metadata,
		options: CallOptions,
		callback: UnaryCallback<ProtoResponseEnvelope>,
	): ClientUnaryCall;
	resolveApproval(
		request: ProtoRequestEnvelope,
		metadata: Metadata,
		options: CallOptions,
		callback: UnaryCallback<ProtoResponseEnvelope>,
	): ClientUnaryCall;
	cancel(
		request: ProtoRequestEnvelope,
		metadata: Metadata,
		options: CallOptions,
		callback: UnaryCallback<ProtoResponseEnvelope>,
	): ClientUnaryCall;
	resume(
		request: ProtoRequestEnvelope,
		metadata: Metadata,
		options: CallOptions,
		callback: UnaryCallback<ProtoResponseEnvelope>,
	): ClientUnaryCall;
	streamEvents(
		request: ProtoStreamEventsRequest,
		metadata: Metadata,
		options: CallOptions,
	): ClientReadableStream<ProtoEventEnvelope>;
	close(): void;
}

type UnaryCallback<T> = (error: ServiceError | null, response?: T) => void;

function jsonBuffer(value: unknown): Buffer {
	assertJsonSize(value, CONTROL_PLANE_MAX_REQUEST_BYTES, "request payload");
	return Buffer.from(JSON.stringify(value) as string, "utf8");
}

function parseJson<T>(buffer: Buffer, maxBytes: number, label: string): T {
	if (buffer.byteLength > maxBytes) throw new ControlPlaneContractError(`${label} exceeds ${maxBytes} bytes`);
	try {
		return JSON.parse(buffer.toString("utf8")) as T;
	} catch {
		throw new ControlPlaneContractError(`${label} is not valid JSON`);
	}
}

function unary<T>(call: (callback: UnaryCallback<T>) => ClientUnaryCall): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		call((error, response) => {
			if (error) reject(new ControlPlaneRpcError(error));
			else if (response === undefined) reject(new Error("control-plane returned an empty response"));
			else resolve(response);
		});
	});
}

function eventFromWire(event: ProtoEventEnvelope): ControlPlaneEvent {
	const sequence = Number(event.sequence);
	if (!Number.isSafeInteger(sequence) || sequence < 1) throw new ControlPlaneContractError("event sequence is invalid");
	return {
		contractVersion: CONTROL_PLANE_CONTRACT_VERSION,
		sessionId: event.sessionId,
		sequence,
		eventId: event.eventId,
		...(event.turnId ? { turnId: event.turnId } : {}),
		kind: event.kind,
		visibility: event.visibility,
		payload: parseJson<SessionJsonValue>(event.payloadJson, CONTROL_PLANE_MAX_EVENT_BYTES, "event payload"),
		occurredAt: event.occurredAt,
		replayed: event.replayed,
		terminal: event.terminal,
	};
}

export class ControlPlaneRpcError extends Error {
	readonly code: number;
	readonly grpcCode: number;

	constructor(error: ServiceError) {
		super(error.details || error.message);
		this.name = "ControlPlaneRpcError";
		this.code = error.code;
		this.grpcCode = error.code;
	}
}

/** Reference client backed by the generated proto-loader gRPC client. */
export class HarnessControlPlaneClient {
	private readonly client: GeneratedHarnessClient;
	private readonly endpoint: ControlPlaneClientOptions["endpoint"];
	private readonly principalId: string | undefined;
	private readonly deadlineMs: number;

	constructor(options: ControlPlaneClientOptions) {
		this.endpoint = options.endpoint;
		this.principalId = options.principalId;
		this.deadlineMs = options.defaultDeadlineMs ?? 10_000;
		const Constructor = getHarnessControlPlaneClientConstructor() as unknown as new (
			address: string,
			creds: ReturnType<typeof credentials.createInsecure>,
		) => GeneratedHarnessClient;
		this.client =
			(options.client as GeneratedHarnessClient | undefined) ??
			new Constructor(`${options.endpoint.address}:${options.endpoint.port}`, credentials.createInsecure());
	}

	close(): void {
		this.client.close();
	}

	private metadata(): Metadata {
		const metadata = new Metadata();
		metadata.set("authorization", `Bearer ${this.endpoint.token}`);
		if ("contractVersion" in this.endpoint && this.endpoint.contractVersion)
			metadata.set("x-blok-control-version", this.endpoint.contractVersion);
		if (this.principalId) metadata.set("x-blok-principal-id", this.principalId);
		return metadata;
	}

	private options(): CallOptions {
		return { deadline: new Date(Date.now() + this.deadlineMs) };
	}

	private envelope(payload: unknown, sessionId = "", turnId = ""): ProtoRequestEnvelope {
		const payloadJson = jsonBuffer(payload);
		return {
			contractVersion: CONTROL_PLANE_CONTRACT_VERSION,
			requestId: randomUUID(),
			sessionId,
			turnId,
			deadlineUnixMs: String(Date.now() + this.deadlineMs),
			payloadJson,
			metadata: {},
		};
	}

	private async callEnvelope<T>(
		method: keyof GeneratedHarnessClient,
		payload: unknown,
		sessionId = "",
		turnId = "",
	): Promise<T> {
		const envelope = this.envelope(payload, sessionId, turnId);
		const response = await unary<ProtoResponseEnvelope>((callback) => {
			const fn = this.client[method];
			if (typeof fn !== "function") throw new Error(`unknown control-plane method ${String(method)}`);
			return (
				fn as (
					request: ProtoRequestEnvelope,
					metadata: Metadata,
					options: CallOptions,
					callback: UnaryCallback<ProtoResponseEnvelope>,
				) => ClientUnaryCall
			).call(this.client, envelope, this.metadata(), this.options(), callback as UnaryCallback<ProtoResponseEnvelope>);
		});
		return parseJson<T>(response.payloadJson, CONTROL_PLANE_MAX_RESPONSE_BYTES, "response payload");
	}

	async capabilities(): Promise<ControlPlaneCapabilities> {
		const response = await unary<ProtoCapabilitiesResponse>((callback) =>
			this.client.getCapabilities({}, this.metadata(), this.options(), callback),
		);
		return {
			contractVersion: CONTROL_PLANE_CONTRACT_VERSION,
			supportedVersions: response.supportedVersions,
			operations: response.operations as ControlPlaneCapabilities["operations"],
			maxRequestBytes: response.maxRequestBytes,
			maxResponseBytes: response.maxResponseBytes,
			maxEventBytes: response.maxEventBytes,
			supportsCursorResume: response.supportsCursorResume,
			supportsAuthentication: response.supportsAuthentication,
			supportsDeadlines: response.supportsDeadlines,
			supportsCancellation: response.supportsCancellation,
		};
	}

	async health(): Promise<ProtoHealthResponse> {
		return unary<ProtoHealthResponse>((callback) =>
			this.client.health(
				{ contractVersion: CONTROL_PLANE_CONTRACT_VERSION, service: "" },
				this.metadata(),
				this.options(),
				callback,
			),
		);
	}

	async readiness(): Promise<ProtoHealthResponse> {
		return unary<ProtoHealthResponse>((callback) =>
			this.client.readiness(
				{ contractVersion: CONTROL_PLANE_CONTRACT_VERSION, service: "" },
				this.metadata(),
				this.options(),
				callback,
			),
		);
	}

	createSession(input: CreateSessionRequest): Promise<SessionResponse> {
		return this.callEnvelope("createSession", input);
	}

	openSession(input: OpenSessionRequest): Promise<SessionResponse> {
		return this.callEnvelope("openSession", input);
	}

	forkSession(input: ForkSessionRequest): Promise<SessionResponse> {
		return this.callEnvelope("forkSession", input);
	}

	inspectSession(input: OpenSessionRequest): Promise<SessionResponse> {
		return this.callEnvelope("inspectSession", input, input.sessionId);
	}

	submitTurn(sessionId: string, input: SubmitTurnRequest): Promise<TurnResponse> {
		return this.callEnvelope("submitTurn", input, sessionId, input.turnId ?? "");
	}

	steerTurn(sessionId: string, input: SteerTurnRequest): Promise<TurnResponse> {
		return this.callEnvelope("steerTurn", input, sessionId, input.turnId);
	}

	startWorkflow(sessionId: string, input: StartWorkflowRequest): Promise<WorkflowResponse> {
		return this.callEnvelope("startWorkflow", input, sessionId);
	}

	answerInteraction(sessionId: string, input: AnswerInteractionRequest): Promise<InteractionResponse> {
		return this.callEnvelope("answerInteraction", input, sessionId);
	}

	resolveApproval(sessionId: string, input: AnswerInteractionRequest): Promise<InteractionResponse> {
		return this.callEnvelope("resolveApproval", input, sessionId);
	}

	cancel(sessionId: string, input: CancelRequest): Promise<CancelResponse> {
		return this.callEnvelope("cancel", input, sessionId);
	}

	resume(sessionId: string, input: ResumeRequest): Promise<ResumeResponse> {
		return this.callEnvelope("resume", input, sessionId);
	}

	streamEvents(input: StreamEventsRequest, options: StreamEventsOptions = {}): AsyncIterable<ControlPlaneEvent> {
		const self = this;
		return (async function* stream(): AsyncGenerator<ControlPlaneEvent> {
			let afterSequence = input.afterSequence ?? 0;
			let reconnects = 0;
			while (true) {
				if (options.signal?.aborted) return;
				const request: ProtoStreamEventsRequest = {
					contractVersion: CONTROL_PLANE_CONTRACT_VERSION,
					requestId: randomUUID(),
					sessionId: input.sessionId,
					afterSequence: String(afterSequence),
					limit: input.limit ?? CONTROL_PLANE_DEFAULT_PAGE_SIZE,
					follow: input.follow ?? false,
					deadlineUnixMs: String(Date.now() + self.deadlineMs),
				};
				const stream = self.client.streamEvents(request, self.metadata(), self.options());
				const abort = (): void => stream.cancel();
				options.signal?.addEventListener("abort", abort, { once: true });
				try {
					for await (const wire of stream as unknown as AsyncIterable<ProtoEventEnvelope>) {
						const event = eventFromWire(wire);
						if (event.sequence <= afterSequence) continue;
						afterSequence = event.sequence;
						yield event;
					}
					return;
				} catch (error) {
					if (!options.reconnect || reconnects >= (options.maxReconnects ?? 3) || options.signal?.aborted) {
						if (isServiceError(error)) throw new ControlPlaneRpcError(error);
						throw error;
					}
					reconnects += 1;
				} finally {
					options.signal?.removeEventListener("abort", abort);
				}
			}
		})();
	}
}

function isServiceError(value: unknown): value is ServiceError {
	return value !== null && typeof value === "object" && typeof (value as { code?: unknown }).code === "number";
}

export { CONTROL_PLANE_SUPPORTED_VERSIONS };
