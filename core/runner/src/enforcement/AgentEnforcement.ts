import {
	type AgentStepContract,
	type AssertionGateContract,
	EnforcementViolationError,
	type EvidenceGateContract,
	type EvidenceGateRequirement,
	type NodeBase,
	type TrustedEvidence,
} from "@blokjs/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPath(value: unknown, path: string | undefined): unknown {
	if (!path) return value;
	let current: unknown = value;
	for (const segment of path.split(".").filter(Boolean)) {
		if (!isRecord(current) || !(segment in current)) return undefined;
		current = current[segment];
	}
	return current;
}

function equalValue(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) && Array.isArray(right))
		return left.length === right.length && left.every((item, index) => equalValue(item, right[index]));
	if (isRecord(left) && isRecord(right)) {
		const leftKeys = Object.keys(left);
		const rightKeys = Object.keys(right);
		return (
			leftKeys.length === rightKeys.length &&
			leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && equalValue(left[key], right[key]))
		);
	}
	return false;
}

function fail(stepId: string, reasonCode: string, message: string): never {
	throw new EnforcementViolationError(
		reasonCode,
		`Step "${stepId}" rejected by enforcement (${reasonCode}): ${message}`,
	);
}

/** Validate the explicit completion signal returned by an agent/model step. */
export function enforceAgentStepCompletion(stepId: string, output: unknown, contract: AgentStepContract): void {
	const completion = contract.completion;
	if (completion.required === false) return;
	const path = completion.path ?? "completed";
	const expected = completion.equals === undefined ? true : completion.equals;
	const actual = readPath(output, path);
	if (!equalValue(actual, expected)) {
		fail(
			stepId,
			"AGENT_STEP_INCOMPLETE",
			`completion field "${path}" must equal ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}`,
		);
	}
	// A model must not promote its own result to a trusted boundary by adding a
	// provenance-looking field. Trusted output is established by the node
	// descriptor and the runner, never by returned JSON.
	if (isRecord(output) && output.provenance === "trusted")
		fail(stepId, "MODEL_OUTPUT_CLAIMS_TRUST", "model output cannot claim trusted provenance");
}

/** Validate an assertion produced by a trusted deterministic node. */
export function enforceAssertionGate(
	stepId: string,
	output: unknown,
	contract: AssertionGateContract,
	trusted: boolean,
): void {
	if (!trusted) fail(stepId, "ASSERTION_UNTRUSTED_OUTPUT", "assertions must be produced by a trusted node");
	const actual = readPath(output, contract.path);
	const passed =
		contract.equals !== undefined
			? equalValue(actual, contract.equals)
			: contract.truthy === undefined
				? Boolean(actual)
				: Boolean(actual) === contract.truthy;
	if (!passed) {
		fail(
			stepId,
			"ASSERTION_FAILED",
			contract.message ?? `assertion at "${contract.path ?? "<output>"}" evaluated to false`,
		);
	}
}

function isTrustedEvidence(value: unknown): value is TrustedEvidence {
	if (!isRecord(value)) return false;
	const producer = value.producer;
	const artifact = value.artifact;
	return (
		value.version === "1" &&
		value.provenance === "trusted" &&
		value.verified === true &&
		isRecord(producer) &&
		typeof producer.stepId === "string" &&
		typeof producer.workflow === "string" &&
		isRecord(artifact) &&
		typeof artifact.id === "string" &&
		typeof artifact.version === "string"
	);
}

function parseEvidence(value: unknown): TrustedEvidence[] {
	if (!isRecord(value) || !Array.isArray(value.evidence)) return [];
	return value.evidence.filter(isTrustedEvidence);
}

function matchesEvidence(evidence: TrustedEvidence, requirement: EvidenceGateRequirement): boolean {
	return (
		evidence.artifact.id === requirement.artifactId &&
		evidence.artifact.version === requirement.artifactVersion &&
		evidence.producer.stepId === requirement.producerStepId
	);
}

/**
 * Verify that every required evidence item is present and trusted. Invalid or
 * model-provenance records are rejected rather than ignored, so omission cannot
 * accidentally look like a successful gate.
 */
export function enforceEvidenceGate(
	stepId: string,
	output: unknown,
	contract: EvidenceGateContract,
	trusted: boolean,
): void {
	if (!trusted) fail(stepId, "EVIDENCE_UNTRUSTED_OUTPUT", "evidence must be produced by a trusted node");
	if (!isRecord(output) || !Array.isArray(output.evidence))
		fail(stepId, "EVIDENCE_MISSING", "output must contain an evidence array");
	const rawEvidence = output.evidence;
	if (rawEvidence.some((item) => isRecord(item) && item.provenance === "model"))
		fail(stepId, "MODEL_EVIDENCE_REJECTED", "model-produced evidence cannot satisfy a trusted gate");
	if (rawEvidence.some((item) => !isTrustedEvidence(item)))
		fail(stepId, "EVIDENCE_UNTRUSTED_OUTPUT", "every evidence record must be a verified trusted record");
	const evidence = parseEvidence(output);
	for (const requirement of contract.requirements) {
		if (!evidence.some((item) => matchesEvidence(item, requirement))) {
			fail(
				stepId,
				"EVIDENCE_REQUIREMENT_UNSATISFIED",
				`missing trusted evidence for artifact "${requirement.artifactId}@${requirement.artifactVersion}" from step "${requirement.producerStepId}"`,
			);
		}
	}
}

/** Apply all declared H1-02 output checks at the one RunnerSteps boundary. */
export function enforceStepOutput(step: NodeBase, output: unknown): void {
	if (step.agentStep) enforceAgentStepCompletion(step.name, output, step.agentStep);
	const trusted =
		step.agentStep === undefined &&
		step.outputTrust === "trusted" &&
		step.capabilityManifest?.determinism === "deterministic";
	if (step.outputTrust === "trusted" && !trusted)
		fail(step.name, "TRUSTED_OUTPUT_INVALID", "trusted output requires a deterministic non-agent node manifest");
	if (step.assertionGate) enforceAssertionGate(step.name, output, step.assertionGate, trusted);
	if (step.evidenceGate) enforceEvidenceGate(step.name, output, step.evidenceGate, trusted);
}
