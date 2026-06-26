import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ObservabilityModuleDescriptor, getObservabilityModule } from "./descriptor.js";

const alerting = getObservabilityModule("alerting") as ObservabilityModuleDescriptor;
const errorSink = getObservabilityModule("error-sink") as ObservabilityModuleDescriptor;

describe("alerting + error-sink modules (MO-ALERTS)", () => {
	it("alerting depends on metrics, declares alertmanager, and enables alerting", () => {
		expect(alerting.dependencies).toEqual(["metrics"]);
		expect(alerting.composeServices).toEqual(["alertmanager"]);
		expect(alerting.envBlock({ projectDir: "/x" })).toContain("BLOK_ALERTING_ENABLED=true");
	});

	it("error-sink ships inert — SENTRY_DSN is commented out", () => {
		for (const line of errorSink.envBlock({ projectDir: "/x" }).split("\n")) {
			if (/SENTRY_DSN=/.test(line)) expect(line.trim().startsWith("#")).toBe(true);
		}
	});

	describe("verify()", () => {
		let tmp: string;
		beforeEach(() => {
			tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blok-alerts-"));
		});
		afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

		it("error-sink: inert when no SENTRY_DSN", async () => {
			fs.writeFileSync(path.join(tmp, ".env.local"), "# SENTRY_DSN=\n");
			expect((await errorSink.verify?.(tmp))?.message).toMatch(/inert/);
		});

		it("error-sink: flags the missing dep when DSN is set but @sentry/node is absent", async () => {
			fs.writeFileSync(path.join(tmp, ".env.local"), "SENTRY_DSN=https://k@e.test/1\n");
			expect((await errorSink.verify?.(tmp))?.message).toMatch(/@sentry\/node missing/);
		});

		it("alerting: points at obs-stack when the rules file isn't in the project", async () => {
			expect((await alerting.verify?.(tmp))?.message).toMatch(/obs-stack=full/);
		});

		it("alerting: reports rules present when they exist", async () => {
			fs.mkdirSync(path.join(tmp, "infra", "metrics", "rules"), { recursive: true });
			fs.writeFileSync(path.join(tmp, "infra", "metrics", "rules", "blok-alerts.yml"), "groups: []\n");
			expect((await alerting.verify?.(tmp))?.message).toMatch(/alert rules present/);
		});
	});
});
