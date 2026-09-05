import { describe, expect, it } from "vitest";
import { campaignCases, runCampaign } from "../src";
import { serializeCampaignReport } from "../src/report";

describe("H4-03 adversarial campaign", () => {
	it("runs every deterministic fixture and records unavailable coverage as deferred", async () => {
		const report = await runCampaign();

		expect(report.summary.failed).toBe(0);
		expect(report.summary.passed).toBeGreaterThanOrEqual(7);
		expect(report.summary.deferred).toBeGreaterThanOrEqual(3);
		expect(report.results.map((result) => result.id)).toEqual([...campaignCases].map((testCase) => testCase.id).sort());
		expect(report.results.filter((result) => result.status === "deferred").map((result) => result.id)).toEqual([
			"recovery.crash-restart-infra",
			"security.filesystem-race-special-file",
			"workflow.h4-02-adherence",
		]);
	});

	it("produces stable, machine-readable output when timing is excluded", async () => {
		const first = serializeCampaignReport(await runCampaign());
		const second = serializeCampaignReport(await runCampaign());

		expect(JSON.parse(first)).toEqual(JSON.parse(second));
		expect(first).not.toContain("durationMs");
		expect(first).toContain('"externalServices": []');
	});

	it("does not turn an unimplemented local case into a pass", async () => {
		const report = await runCampaign({
			cases: [
				{
					id: "fixture.must-fail",
					category: "fixture",
					title: "intentional failure",
					availability: "deterministic-local",
					governingAdrs: [],
					run: async () => {
						throw new Error("fixture failure");
					},
				},
			],
		});

		expect(report.summary).toEqual({ total: 1, passed: 0, failed: 1, deferred: 0 });
		expect(report.results[0]?.error).toMatchObject({ message: "fixture failure" });
	});
});
