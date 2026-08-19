import { middlewareStateKeys, nodeSchemaLookup, validateRefs } from "@blokjs/helper";

/**
 * Boot-time schema-aware `$ref` validation (#691).
 *
 * Every registered workflow's step-output references are checked against the
 * declared output schema of the producing step's node, using the SAME catalog
 * `GET /__blok/nodes` serves — so runtime (python/rust/…) nodes are covered
 * exactly as far as their SDK advertises schemas (ADR 0010).
 *
 * **Advisory by default**, preserving #305/#308's scope: errors are logged and
 * boot continues. `BLOK_VALIDATE_REFS=strict` makes them fail boot instead;
 * `BLOK_VALIDATE_REFS=off` silences the pass entirely.
 *
 * // ponytail: wired into the HTTP trigger's boot, which is where the node
 * // catalog and the full workflow registry already meet. Worker/cron-only
 * // deployments get the same coverage from `blokctl check` in CI; move this
 * // into TriggerBase if someone runs a workerless-HTTP-less deployment and
 * // wants boot-time enforcement there too.
 */

export type RefValidationMode = "off" | "advisory" | "strict";

export function readRefValidationMode(env: string | undefined): RefValidationMode {
	if (env === "strict") return "strict";
	if (env === "off" || env === "false" || env === "0") return "off";
	return "advisory";
}

interface CatalogEntry {
	readonly name?: string;
	readonly ref?: string;
	readonly outputSchema?: unknown;
}

interface WorkflowEntry {
	readonly name: string;
	readonly source: string;
	readonly workflow: unknown;
}

export interface BootRefValidationResult {
	readonly errorLines: readonly string[];
	readonly workflowCount: number;
	readonly uncheckedStepCount: number;
}

/**
 * Run the pass over every registered workflow. Pure (no logging, no throwing)
 * so it is testable without booting a server; {@link reportRefsAtBoot} owns the
 * policy.
 */
export function collectBootRefErrors(
	workflows: readonly WorkflowEntry[],
	catalog: readonly CatalogEntry[],
): BootRefValidationResult {
	const lookup = nodeSchemaLookup(catalog);
	const knownStateKeys = middlewareStateKeys(workflows.map((w) => w.workflow));
	const errorLines: string[] = [];
	let uncheckedStepCount = 0;

	for (const entry of workflows) {
		const result = validateRefs(entry.workflow, {
			nodes: lookup,
			knownStateKeys,
			workflowName: entry.name,
		});
		uncheckedStepCount += result.uncheckedSteps.length;
		for (const d of result.diagnostics) {
			if (d.severity !== "error") continue;
			errorLines.push(`${entry.source} → ${d.path} [${d.code}]\n${d.message}`);
		}
	}

	return { errorLines, workflowCount: workflows.length, uncheckedStepCount };
}

/**
 * Log (advisory) or throw (strict) the boot ref diagnostics. Returns the
 * result so callers can assert on it.
 */
export function reportRefsAtBoot(
	result: BootRefValidationResult,
	mode: RefValidationMode,
	logger: { log: (msg: string) => void; error: (msg: string) => void },
): BootRefValidationResult {
	if (mode === "off" || result.errorLines.length === 0) return result;

	const detail = result.errorLines.join("\n\n");
	const header = `[blok][refs] ${result.errorLines.length} step-output reference error(s) across ${result.workflowCount} workflow(s):\n${detail}`;

	if (mode === "strict") {
		throw new Error(`${header}\n\nBLOK_VALIDATE_REFS=strict — refusing to boot. Unset it to downgrade to warnings.`);
	}
	logger.error(`${header}\n\nAdvisory only — set BLOK_VALIDATE_REFS=strict to fail boot on these.`);
	return result;
}
