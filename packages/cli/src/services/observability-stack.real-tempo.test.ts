import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RUN = process.env.BLOK_INTEGRATION_TEMPO;
const d = RUN ? describe : describe.skip;

const TEMPO_API = process.env.BLOK_TEMPO_API_URL ?? "http://localhost:3201";
const TEMPO_OTLP = process.env.BLOK_TEMPO_OTLP_URL ?? "http://localhost:4318/v1/traces";

function findRepoRoot(): string | null {
	let dir = import.meta.dirname;
	for (let i = 0; i < 8; i++) {
		if (fs.existsSync(path.join(dir, "infra", "metrics", "tempo.yaml"))) return dir;
		const up = path.dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return null;
}

function hex(bytes: number): string {
	return randomBytes(bytes).toString("hex");
}

function dockerLogs(container: string): string {
	const result = spawnSync("docker", ["logs", container], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || `docker logs ${container} failed`);
	return `${result.stdout}\n${result.stderr}`;
}

async function waitForTrace(traceId: string): Promise<Response> {
	let last: Response | undefined;
	for (let i = 0; i < 20; i++) {
		last = await fetch(`${TEMPO_API}/api/traces/${traceId}`);
		if (last.ok) return last;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return last ?? fetch(`${TEMPO_API}/api/traces/${traceId}`);
}

d("observability stack - Tempo live", () => {
	it("boots without the dangling memcached cache and ingests an OTLP span", async () => {
		const repo = findRepoRoot();
		if (!repo) throw new Error("repo root not found");

		const tempoConfig = fs.readFileSync(path.join(repo, "infra", "metrics", "tempo.yaml"), "utf8");
		expect(tempoConfig).not.toContain("memcached:11211");

		const traceId = hex(16);
		const spanId = hex(8);
		const now = BigInt(Date.now()) * 1_000_000n;
		const response = await fetch(TEMPO_OTLP, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				resourceSpans: [
					{
						resource: { attributes: [{ key: "service.name", value: { stringValue: "blok-tempo-live-test" } }] },
						scopeSpans: [
							{
								scope: { name: "blokctl-live-test" },
								spans: [
									{
										traceId,
										spanId,
										name: "tempo-memcached-regression",
										kind: 1,
										startTimeUnixNano: now.toString(),
										endTimeUnixNano: (now + 1_000_000n).toString(),
									},
								],
							},
						],
					},
				],
			}),
		});

		expect(response.status).toBe(200);
		const trace = await waitForTrace(traceId);
		expect(trace.ok).toBe(true);
		const traceBody = await trace.text();
		expect(traceBody).toContain("blok-tempo-live-test");
		expect(traceBody).toContain("tempo-memcached-regression");

		const logs = dockerLogs("tempo");
		expect(logs.toLowerCase()).not.toContain("memcached");
	});
});
