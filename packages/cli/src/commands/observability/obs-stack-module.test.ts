import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ObservabilityModuleDescriptor, getObservabilityModule } from "./descriptor.js";

const obsStack = getObservabilityModule("obs-stack") as ObservabilityModuleDescriptor;

describe("obs-stack module retrofit (MO-STACK T4)", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blok-obsstack-"));
	});
	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

	it("scaffold with tier=none is a no-op (writes nothing)", async () => {
		const r = await obsStack.scaffold?.({ projectDir: tmp, nonInteractive: true, tier: "none" });
		expect(r).toEqual({ filesCreated: [] });
		expect(fs.existsSync(path.join(tmp, "infra"))).toBe(false);
	});

	it("verify reports tier-none when no stack is present", async () => {
		expect((await obsStack.verify?.(tmp))?.message).toMatch(/tier none/);
	});

	it("verify reports the service count when a stack is present", async () => {
		fs.mkdirSync(path.join(tmp, "infra", "metrics"), { recursive: true });
		fs.writeFileSync(
			path.join(tmp, "infra", "metrics", "docker-compose.yml"),
			"services:\n  prometheus: {}\n  grafana: {}\n",
		);
		const r = await obsStack.verify?.(tmp);
		expect(r?.message).toMatch(/2 service/);
		expect(r?.dashboardUrl).toContain("3000");
	});

	it("cleanup removes the copied infra/metrics (the remove contract)", async () => {
		fs.mkdirSync(path.join(tmp, "infra", "metrics"), { recursive: true });
		await obsStack.cleanup?.({ projectDir: tmp, nonInteractive: true });
		expect(fs.existsSync(path.join(tmp, "infra", "metrics"))).toBe(false);
	});
});
