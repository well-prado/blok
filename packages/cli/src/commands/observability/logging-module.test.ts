import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ObservabilityModuleDescriptor, getObservabilityModule } from "./descriptor.js";

const logging = getObservabilityModule("logging") as ObservabilityModuleDescriptor;

describe("logging module (MO-LOGGING)", () => {
	it("depends on trace-store and declares loki + alloy compose services", () => {
		expect(logging.dependencies).toEqual(["trace-store"]);
		expect(logging.composeServices).toEqual(["loki", "alloy"]);
	});

	it("envBlock turns structured logging on", () => {
		expect(logging.envBlock({ projectDir: "/tmp/x" })).toContain("CONSOLE_LOG_ACTIVE=true");
	});

	describe("verify()", () => {
		let tmp: string;
		beforeEach(() => {
			tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blok-logging-"));
		});
		afterEach(() => {
			fs.rmSync(tmp, { recursive: true, force: true });
		});

		it("reports OFF when CONSOLE_LOG_ACTIVE isn't true", async () => {
			fs.writeFileSync(path.join(tmp, ".env.local"), "PORT=4000\n# CONSOLE_LOG_ACTIVE=true\n");
			const r = await logging.verify?.(tmp);
			expect(r?.message).toMatch(/OFF/);
		});

		it("reports on-but-no-shipper when logging is active without the alloy config", async () => {
			fs.writeFileSync(path.join(tmp, ".env.local"), "CONSOLE_LOG_ACTIVE=true\n");
			const r = await logging.verify?.(tmp);
			expect(r?.message).toMatch(/add obs-stack=full/);
			expect(r?.dashboardUrl).toBeUndefined();
		});

		it("reports shipping when active AND the alloy config is present", async () => {
			fs.writeFileSync(path.join(tmp, ".env.local"), "CONSOLE_LOG_ACTIVE=true\n");
			fs.mkdirSync(path.join(tmp, "infra", "metrics"), { recursive: true });
			fs.writeFileSync(path.join(tmp, "infra", "metrics", "alloy-config.alloy"), "// alloy\n");
			const r = await logging.verify?.(tmp);
			expect(r?.message).toMatch(/shipping JSON logs to Loki/);
			expect(r?.dashboardUrl).toContain("/explore");
		});
	});
});
