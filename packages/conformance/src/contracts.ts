export const CONFORMANCE_CONTRACT_VERSION = "1" as const;

export type CampaignAvailability = "deterministic-local" | "platform" | "h4-02";
export type CampaignStatus = "passed" | "failed" | "deferred";

export interface CampaignCase {
	readonly id: string;
	readonly category: string;
	readonly title: string;
	readonly availability: CampaignAvailability;
	readonly governingAdrs: readonly string[];
	readonly supportedPlatforms?: readonly NodeJS.Platform[];
	readonly integrationSeam?: string;
	readonly run?: () => readonly string[] | Promise<readonly string[]>;
}

export interface CampaignCaseResult {
	readonly id: string;
	readonly category: string;
	readonly status: CampaignStatus;
	readonly evidence: readonly string[];
	readonly durationMs?: number;
	readonly error?: { readonly name: string; readonly message: string };
}

export interface CampaignEnvironmentManifest {
	readonly contractVersion: typeof CONFORMANCE_CONTRACT_VERSION;
	readonly frameworkVersion: string;
	readonly runtime: {
		readonly node: string;
		readonly bun: string | null;
		readonly platform: NodeJS.Platform;
		readonly arch: string;
	};
	readonly source: {
		readonly commit: string;
		readonly dirty: boolean | null;
	};
	readonly externalServices: readonly string[];
	readonly profile: "deterministic-local";
}

export interface CampaignReport {
	readonly contractVersion: typeof CONFORMANCE_CONTRACT_VERSION;
	readonly environment: CampaignEnvironmentManifest;
	readonly results: readonly CampaignCaseResult[];
	readonly summary: {
		readonly total: number;
		readonly passed: number;
		readonly failed: number;
		readonly deferred: number;
	};
}
