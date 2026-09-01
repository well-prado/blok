import type { InteractionAttribution, InteractionSuspension, PolicyDecision, PolicyRequest } from "./PolicyContracts";

export const INTERACTION_VERSION = "1" as const;
/** The maximum UTF-8 size of an answer or any nested answer value. */
export const INTERACTION_MAX_PAYLOAD_BYTES = 64 * 1024;
/** Limits protect persistence and control-plane consumers from pathological JSON. */
export const INTERACTION_MAX_PAYLOAD_DEPTH = 8;
export const INTERACTION_MAX_PAYLOAD_ITEMS = 256;
export const INTERACTION_MAX_STRING_LENGTH = 8 * 1024;
export const INTERACTION_MAX_LINEAGE_DEPTH = 32;
export const INTERACTION_MAX_LINEAGE_PATH = 32;
export const INTERACTION_REDACTED_VALUE = "[REDACTED]" as const;

export type InteractionStatus = "pending" | "answered" | "denied" | "expired" | "cancelled";

/** JSON-only values accepted at the durable interaction boundary. */
export type InteractionPayload =
	| string
	| number
	| boolean
	| null
	| readonly InteractionPayload[]
	| Readonly<{ [key: string]: InteractionPayload }>;

export class InteractionContractError extends Error {
	readonly code = "INTERACTION_INVALID";

	constructor(message: string) {
		super(message);
		this.name = "InteractionContractError";
	}
}

export interface InteractionRecord {
	readonly version: typeof INTERACTION_VERSION;
	readonly id: string;
	readonly request: PolicyRequest;
	readonly decision: PolicyDecision;
	readonly status: InteractionStatus;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly sequence: number;
	readonly answer?: InteractionPayload;
	readonly answeredBy?: string;
	readonly answeredAt?: string;
	/** Set when the answered record is atomically claimed for resumption. */
	readonly claimedBy?: string;
	readonly claimedAt?: string;
	/** Reference to the suspended run/cursor; persisted separately from trace state. */
	readonly suspension?: InteractionSuspension;
}

export interface InteractionAnswer {
	readonly id: string;
	readonly principalId: string;
	readonly answer?: InteractionPayload;
	readonly deny?: boolean;
	readonly sequence: number;
}

export interface InteractionStore {
	create(request: PolicyRequest, decision: PolicyDecision, opts?: { expiresAt?: string }): Promise<InteractionRecord>;
	get(id: string): Promise<InteractionRecord | undefined>;
	answer(answer: InteractionAnswer): Promise<InteractionRecord>;
	/**
	 * Atomically consume an answered interaction for one resume attempt.
	 * Implementations must compare both the principal and expected sequence
	 * in the same transaction as the claim.
	 */
	claim(id: string, principalId: string, sequence: number): Promise<InteractionRecord>;
	cancel(id: string, principalId: string, sequence: number): Promise<InteractionRecord>;
	expire(now?: string): Promise<readonly InteractionRecord[]>;
}

const SENSITIVE_KEY =
	/(?:pass(?:word|code)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|session)/i;
const SENSITIVE_TEXT =
	/(?:bearer\s+|\b(?:pass(?:word|code)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key)\b\s*[:=]?)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function fail(path: string, message: string): never {
	throw new InteractionContractError(`${path} ${message}`);
}

function validatePayload(value: unknown, path: string, seen: WeakSet<object>, depth: number): InteractionPayload {
	if (depth > INTERACTION_MAX_PAYLOAD_DEPTH) fail(path, `exceeds maximum depth of ${INTERACTION_MAX_PAYLOAD_DEPTH}`);
	if (value === null) return value;
	if (typeof value === "string") {
		if (value.length > INTERACTION_MAX_STRING_LENGTH) fail(path, "contains an oversized string");
		return value;
	}
	if (typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) fail(path, "must contain only finite numbers");
		return value;
	}
	if (typeof value !== "object") fail(path, "must be JSON-serializable");
	if (seen.has(value)) fail(path, "must not contain circular references");
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > INTERACTION_MAX_PAYLOAD_ITEMS) fail(path, "contains too many items");
			return value.map((item, index) => validatePayload(item, `${path}[${index}]`, seen, depth + 1));
		}
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
			fail(path, "must contain only plain objects");
		const keys = Object.keys(value);
		if (keys.length > INTERACTION_MAX_PAYLOAD_ITEMS) fail(path, "contains too many fields");
		const output: Record<string, InteractionPayload> = {};
		const objectValue = value as Record<string, unknown>;
		for (const key of keys) output[key] = validatePayload(objectValue[key], `${path}.${key}`, seen, depth + 1);
		return output;
	} finally {
		seen.delete(value);
	}
}

/** Validate and clone a JSON-only interaction payload. */
export function parseInteractionPayload(value: unknown, path = "interaction payload"): InteractionPayload {
	const parsed = validatePayload(value, path, new WeakSet<object>(), 0);
	let serialized: string;
	try {
		serialized = JSON.stringify(parsed);
	} catch {
		throw new InteractionContractError(`${path} must be JSON-serializable`);
	}
	if (byteLength(serialized) > INTERACTION_MAX_PAYLOAD_BYTES)
		throw new InteractionContractError(`${path} exceeds ${INTERACTION_MAX_PAYLOAD_BYTES} bytes`);
	return parsed;
}

function boundedIdentifier(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 256)
		fail(path, "must be a non-empty string of at most 256 characters");
	return value;
}

function parseAttribution(value: unknown): InteractionAttribution | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) fail("interaction attribution", "must be an object");
	const rootId = boundedIdentifier(value.rootId, "interaction attribution.rootId");
	const depth = value.depth;
	if (typeof depth !== "number" || !Number.isSafeInteger(depth) || depth < 0 || depth > INTERACTION_MAX_LINEAGE_DEPTH)
		fail("interaction attribution.depth", `must be an integer from 0 to ${INTERACTION_MAX_LINEAGE_DEPTH}`);
	const result: InteractionAttribution = { rootId, depth };
	for (const key of ["parentId", "branchId"] as const) {
		if (value[key] !== undefined)
			(result as unknown as Record<string, unknown>)[key] = boundedIdentifier(
				value[key],
				`interaction attribution.${key}`,
			);
	}
	const branchIndex = value.branchIndex;
	if (branchIndex !== undefined) {
		if (typeof branchIndex !== "number" || !Number.isSafeInteger(branchIndex) || branchIndex < 0)
			fail("interaction attribution.branchIndex", "must be a non-negative safe integer");
		(result as unknown as Record<string, unknown>).branchIndex = branchIndex;
	}
	if (value.branchPath !== undefined) {
		if (!Array.isArray(value.branchPath) || value.branchPath.length > INTERACTION_MAX_LINEAGE_PATH)
			fail("interaction attribution.branchPath", `must contain at most ${INTERACTION_MAX_LINEAGE_PATH} labels`);
		(result as unknown as Record<string, unknown>).branchPath = value.branchPath.map((item, index) =>
			boundedIdentifier(item, `interaction attribution.branchPath[${index}]`),
		);
	}
	return result;
}

/** Validate an answer received from an untrusted control-plane caller. */
export function parseInteractionAnswer(value: unknown): InteractionAnswer {
	if (!isRecord(value)) throw new InteractionContractError("interaction answer must be an object");
	const id = boundedIdentifier(value.id, "interaction answer.id");
	const principalId = boundedIdentifier(value.principalId, "interaction answer.principalId");
	const sequence = value.sequence;
	if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0)
		fail("interaction answer.sequence", "must be a non-negative safe integer");
	if (value.deny !== undefined && typeof value.deny !== "boolean") fail("interaction answer.deny", "must be a boolean");
	const answer =
		value.answer === undefined ? undefined : parseInteractionPayload(value.answer, "interaction answer.answer");
	return {
		id,
		principalId,
		sequence,
		...(answer === undefined ? {} : { answer }),
		...(value.deny === undefined ? {} : { deny: value.deny }),
	};
}

function redactText(value: string): string {
	return SENSITIVE_TEXT.test(value) ? INTERACTION_REDACTED_VALUE : value.slice(0, INTERACTION_MAX_STRING_LENGTH);
}

/** Make a bounded, JSON-safe snapshot for records and observability sinks. */
export function redactInteractionPayload(value: InteractionPayload): InteractionPayload {
	if (typeof value === "string") return redactText(value);
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map((item) => redactInteractionPayload(item));
	const output: Record<string, InteractionPayload> = {};
	for (const [key, item] of Object.entries(value)) {
		output[key] = SENSITIVE_KEY.test(key) ? INTERACTION_REDACTED_VALUE : redactInteractionPayload(item);
	}
	return output;
}

/** Redact and bound provider-controlled text such as rule IDs and reasons. */
export function redactInteractionString(value: string): string {
	return redactText(value);
}

function redactFragments(
	fragments: Readonly<Record<string, string | number | boolean>>,
): Readonly<Record<string, string | number | boolean>> {
	const result: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(fragments)) {
		result[key] =
			SENSITIVE_KEY.test(key) || (typeof value === "string" && SENSITIVE_TEXT.test(value))
				? INTERACTION_REDACTED_VALUE
				: value;
	}
	return result;
}

/** Remove non-persistable runtime state and redact policy metadata for a record. */
export function redactInteractionRequest(request: PolicyRequest): PolicyRequest {
	const attribution = parseAttribution(request.attribution);
	const { signal: _signal, ...persistable } = request;
	return {
		...persistable,
		...(attribution ? { attribution } : {}),
		scope: { ...request.scope, fragments: redactFragments(request.scope.fragments) },
		layers: request.layers.map((layer) => ({ ...layer })),
	};
}

/** Bound and redact provider-controlled decision text before persistence. */
export function redactInteractionDecision(decision: PolicyDecision): PolicyDecision {
	return {
		...decision,
		id: boundedIdentifier(decision.id, "interaction decision.id"),
		policyVersion: boundedIdentifier(decision.policyVersion, "interaction decision.policyVersion"),
		reasonCode: redactText(boundedIdentifier(decision.reasonCode, "interaction decision.reasonCode")),
		...(decision.reason === undefined
			? {}
			: { reason: redactText(decision.reason.slice(0, INTERACTION_MAX_STRING_LENGTH)) }),
	};
}

/** Return an isolated, deeply immutable snapshot suitable for a store/API. */
export function immutableInteractionSnapshot<T>(value: T): T {
	const snapshot = structuredClone(value);
	const freeze = (item: unknown): void => {
		if (item === null || typeof item !== "object" || Object.isFrozen(item)) return;
		for (const child of Object.values(item)) freeze(child);
		Object.freeze(item);
	};
	freeze(snapshot);
	return snapshot;
}

/** Canonical comparison for duplicate answers with different object key order. */
export function fingerprintInteractionPayload(value: InteractionPayload | undefined): string {
	if (value === undefined) return "undefined";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(fingerprintInteractionPayload).join(",")}]`;
	const objectValue = value as Readonly<{ [key: string]: InteractionPayload }>;
	return `{${Object.keys(objectValue)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${fingerprintInteractionPayload(objectValue[key])}`)
		.join(",")}}`;
}
