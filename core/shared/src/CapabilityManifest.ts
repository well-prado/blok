/**
 * Language-neutral operational metadata for nodes and workflows (ADR 0003).
 *
 * Schemas describe values; this manifest describes risk. It is deliberately
 * data-only so every SDK can emit the same JSON through gRPC `ListNodes`.
 * Unknown object fields are ignored when parsing v1, allowing additive wire
 * evolution, while an unknown VERSION remains ineligible for agent execution.
 */

export const CAPABILITY_MANIFEST_VERSION = "1" as const;

export const CAPABILITY_EFFECTS = [
	"read",
	"write",
	"network",
	"filesystem",
	"process",
	"secret",
	"streaming",
	"destructive",
] as const;

export const CAPABILITY_CLASSIFICATIONS = ["agent-compatible", "trusted-legacy", "denied-to-agents"] as const;
export const CAPABILITY_DETERMINISM = ["deterministic", "time-dependent", "random", "external", "unknown"] as const;
export const CAPABILITY_IDEMPOTENCY = ["idempotent", "conditionally-idempotent", "non-idempotent", "unknown"] as const;
export const CAPABILITY_MATURITY = ["stable", "beta", "experimental", "deprecated"] as const;

export type CapabilityEffect = (typeof CAPABILITY_EFFECTS)[number];
export type CapabilityClassification = (typeof CAPABILITY_CLASSIFICATIONS)[number];
export type CapabilityDeterminism = (typeof CAPABILITY_DETERMINISM)[number];
export type CapabilityIdempotency = (typeof CAPABILITY_IDEMPOTENCY)[number];
export type CapabilityMaturity = (typeof CAPABILITY_MATURITY)[number];

export interface CapabilityResourceBounds {
	maxDurationMs?: number;
	maxMemoryBytes?: number;
	maxInputBytes?: number;
	maxOutputBytes?: number;
	maxConcurrency?: number;
}

export interface CapabilityManifestV1 {
	version: typeof CAPABILITY_MANIFEST_VERSION;
	/** Agent compatibility is explicit; absence never implies safety. */
	classification: CapabilityClassification;
	/** Empty means pure: no externally observable operational effect. */
	effects: CapabilityEffect[];
	/** Fine-grained capability identifiers, e.g. `network.http` or `fs.workspace.read`. */
	capabilities: string[];
	/** Opaque secret reference NAMES only. Never put credentials here. */
	secrets: string[];
	determinism: CapabilityDeterminism;
	idempotency: CapabilityIdempotency;
	maturity: CapabilityMaturity;
	resources?: CapabilityResourceBounds;
	/** Optional applicability constraints. Empty/absent means unrestricted. */
	runtimes?: string[];
	triggers?: string[];
}

export type CapabilityManifestStatus = "declared" | "missing" | "invalid";

export interface CapabilityManifestAssessment {
	status: CapabilityManifestStatus;
	manifest: CapabilityManifestV1 | null;
	errors: string[];
	agentEligible: boolean;
	reason: "eligible" | "missing-manifest" | "invalid-manifest" | "trusted-legacy" | "denied-to-agents";
}

export class CapabilityManifestError extends Error {
	readonly errors: readonly string[];

	constructor(errors: readonly string[]) {
		super(`Invalid capability manifest: ${errors.join("; ")}`);
		this.name = "CapabilityManifestError";
		this.errors = [...errors];
	}
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/;
const EFFECT_SET = new Set<string>(CAPABILITY_EFFECTS);
const CLASSIFICATION_SET = new Set<string>(CAPABILITY_CLASSIFICATIONS);
const DETERMINISM_SET = new Set<string>(CAPABILITY_DETERMINISM);
const IDEMPOTENCY_SET = new Set<string>(CAPABILITY_IDEMPOTENCY);
const MATURITY_SET = new Set<string>(CAPABILITY_MATURITY);
const RESOURCE_KEYS = ["maxDurationMs", "maxMemoryBytes", "maxInputBytes", "maxOutputBytes", "maxConcurrency"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function enumValue<T extends string>(
	value: unknown,
	path: string,
	allowed: ReadonlySet<string>,
	errors: string[],
): T | undefined {
	if (typeof value !== "string" || !allowed.has(value)) {
		errors.push(`${path} must be one of: ${[...allowed].join(", ")}`);
		return undefined;
	}
	return value as T;
}

function stringList(value: unknown, path: string, errors: string[], allowed?: ReadonlySet<string>): string[] {
	if (!Array.isArray(value)) {
		errors.push(`${path} must be an array`);
		return [];
	}
	const result = new Set<string>();
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		if (typeof item !== "string" || (!allowed && !IDENTIFIER.test(item)) || (allowed && !allowed.has(item))) {
			errors.push(`${path}[${i}] is not a valid ${allowed ? "value" : "identifier"}`);
			continue;
		}
		result.add(item);
	}
	return [...result].sort();
}

function resourceBounds(value: unknown, errors: string[]): CapabilityResourceBounds | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		errors.push("resources must be an object");
		return undefined;
	}
	const result: CapabilityResourceBounds = {};
	for (const key of RESOURCE_KEYS) {
		const raw = value[key];
		if (raw === undefined) continue;
		if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
			errors.push(`resources.${key} must be a positive safe integer`);
			continue;
		}
		result[key] = raw as number;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

/** Parse and normalize a v1 manifest. Additive unknown fields are ignored. */
export function parseCapabilityManifest(value: unknown): CapabilityManifestV1 {
	const errors: string[] = [];
	if (!isRecord(value)) throw new CapabilityManifestError(["manifest must be an object"]);

	if (value.version !== CAPABILITY_MANIFEST_VERSION) {
		errors.push(`version must be ${CAPABILITY_MANIFEST_VERSION}`);
	}
	const classification = enumValue<CapabilityClassification>(
		value.classification,
		"classification",
		CLASSIFICATION_SET,
		errors,
	);
	const determinism = enumValue<CapabilityDeterminism>(value.determinism, "determinism", DETERMINISM_SET, errors);
	const idempotency = enumValue<CapabilityIdempotency>(value.idempotency, "idempotency", IDEMPOTENCY_SET, errors);
	const maturity = enumValue<CapabilityMaturity>(value.maturity, "maturity", MATURITY_SET, errors);
	const effects = stringList(value.effects, "effects", errors, EFFECT_SET) as CapabilityEffect[];
	const capabilities = stringList(value.capabilities, "capabilities", errors);
	const secrets = stringList(value.secrets, "secrets", errors);
	const resources = resourceBounds(value.resources, errors);
	const runtimes = value.runtimes === undefined ? undefined : stringList(value.runtimes, "runtimes", errors);
	const triggers = value.triggers === undefined ? undefined : stringList(value.triggers, "triggers", errors);

	if (errors.length > 0 || !classification || !determinism || !idempotency || !maturity) {
		throw new CapabilityManifestError(errors);
	}

	return {
		version: CAPABILITY_MANIFEST_VERSION,
		classification,
		effects,
		capabilities,
		secrets,
		determinism,
		idempotency,
		maturity,
		...(resources ? { resources } : {}),
		...(runtimes ? { runtimes } : {}),
		...(triggers ? { triggers } : {}),
	};
}

/** Stable JSON bytes/order for catalog reflection and cross-runtime fixtures. */
export function serializeCapabilityManifest(value: unknown): string {
	return JSON.stringify(parseCapabilityManifest(value));
}

/**
 * Catalog/policy boundary. Missing and invalid metadata are explicit and
 * agent-ineligible; ordinary execution remains unchanged until policy opts in.
 */
export function assessCapabilityManifest(value: unknown): CapabilityManifestAssessment {
	if (value === undefined || value === null || value === "") {
		return {
			status: "missing",
			manifest: null,
			errors: [],
			agentEligible: false,
			reason: "missing-manifest",
		};
	}
	try {
		const manifest = parseCapabilityManifest(value);
		const eligible = manifest.classification === "agent-compatible";
		const reason = eligible
			? "eligible"
			: manifest.classification === "trusted-legacy"
				? "trusted-legacy"
				: "denied-to-agents";
		return {
			status: "declared",
			manifest,
			errors: [],
			agentEligible: eligible,
			reason,
		};
	} catch (error) {
		const errors = error instanceof CapabilityManifestError ? [...error.errors] : [String(error)];
		return {
			status: "invalid",
			manifest: null,
			errors,
			agentEligible: false,
			reason: "invalid-manifest",
		};
	}
}

/** Fail-closed helper for the future agent execution policy boundary. */
export function requireAgentEligibleManifest(value: unknown): CapabilityManifestV1 {
	const assessment = assessCapabilityManifest(value);
	if (assessment.agentEligible && assessment.manifest) return assessment.manifest;
	const detail = assessment.errors.length > 0 ? assessment.errors : [assessment.reason];
	throw new CapabilityManifestError(detail);
}
