import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ObservabilityModuleDescriptor, getObservabilityModule } from "./descriptor.js";

const tracing = getObservabilityModule("tracing") as ObservabilityModuleDescriptor;

describe("tracing module (MO-TRACING)", () => {
	it("ships inert — every OTEL_EXPORTER_OTLP_ENDPOINT line is commented out", () => {
		const env = tracing.envBlock({ projectDir: "/tmp/x" });
		expect(env).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
		for (const line of env.split("\n")) {
			if (/OTEL_EXPORTER_OTLP_ENDPOINT=/.test(line)) expect(line.trim().startsWith("#")).toBe(true);
		}
	});

	it("declares tempo as its compose service, with no deps + no infra files", () => {
		expect(tracing.composeServices).toEqual(["tempo"]);
		expect(tracing.packageDeps).toEqual({});
		expect(tracing.infraFiles).toEqual([]);
		expect(tracing.dependencies).toEqual([]);
	});

	describe("verify()", () => {
		let tmp: string;
		beforeEach(() => {
			tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blok-tracing-"));
		});
		afterEach(() => {
			fs.rmSync(tmp, { recursive: true, force: true });
		});

		it("reports inert when the endpoint is unset/commented", async () => {
			fs.writeFileSync(path.join(tmp, ".env.local"), "PORT=4000\n# OTEL_EXPORTER_OTLP_ENDPOINT=http://x\n");
			const r = await tracing.verify?.(tmp);
			expect(r?.ok).toBe(true);
			expect(r?.message).toMatch(/inert/);
		});

		it("reports active when the endpoint is uncommented", async () => {
			fs.writeFileSync(path.join(tmp, ".env.local"), "OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318\n");
			const r = await tracing.verify?.(tmp);
			expect(r?.message).toContain("exporting spans to http://tempo:4318");
		});
	});
});
