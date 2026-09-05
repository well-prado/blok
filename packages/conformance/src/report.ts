import { CONFORMANCE_CONTRACT_VERSION, type CampaignEnvironmentManifest, type CampaignReport } from "./contracts";

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, stableValue(child)]),
	);
}

function envFlag(value: string | undefined): boolean | null {
	if (value === undefined) return null;
	return value === "1" || value.toLowerCase() === "true";
}

export function createEnvironmentManifest(): CampaignEnvironmentManifest {
	return {
		contractVersion: CONFORMANCE_CONTRACT_VERSION,
		frameworkVersion: "2.1.0",
		runtime: {
			node: process.versions.node,
			bun: process.versions.bun ?? null,
			platform: process.platform,
			arch: process.arch,
		},
		source: {
			commit: process.env.BLOK_CONFORMANCE_COMMIT ?? process.env.GITHUB_SHA ?? "unknown",
			dirty: envFlag(process.env.BLOK_CONFORMANCE_DIRTY),
		},
		externalServices: [],
		profile: "deterministic-local",
	};
}

export function serializeCampaignReport(report: CampaignReport, includeTiming = false): string {
	const normalized = includeTiming
		? report
		: {
				...report,
				results: report.results.map(({ durationMs: _durationMs, ...result }) => result),
			};
	return JSON.stringify(stableValue(normalized), null, 2);
}
