import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

const RUN = process.env.BLOK_INTEGRATION_PROMETHEUS;
const d = RUN ? describe : describe.skip;

const PROMETHEUS_API = process.env.BLOK_PROMETHEUS_API_URL ?? "http://localhost:9090";

type PrometheusResult = {
	metric: Record<string, string>;
	value: [number, string];
};

type PrometheusTarget = {
	health: string;
	labels: Record<string, string>;
	scrapeUrl: string;
};

function run(command: string, args: string[]): string {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} ${args.join(" ")} failed`);
	return `${result.stdout}\n${result.stderr}`;
}

function removeContainer(name: string): void {
	spawnSync("docker", ["rm", "-f", name], { encoding: "utf8" });
}

async function queryPrometheus(query: string): Promise<{ status: string; data?: { result?: PrometheusResult[] } }> {
	const response = await fetch(`${PROMETHEUS_API}/api/v1/query?query=${encodeURIComponent(query)}`);
	expect(response.status).toBe(200);
	return (await response.json()) as { status: string; data?: { result?: PrometheusResult[] } };
}

async function activeTargets(): Promise<PrometheusTarget[]> {
	const response = await fetch(`${PROMETHEUS_API}/api/v1/targets?state=active`);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { data?: { activeTargets?: PrometheusTarget[] } };
	return body.data?.activeTargets ?? [];
}

async function waitForTarget(instance: string): Promise<PrometheusTarget | undefined> {
	let target: PrometheusTarget | undefined;
	for (let i = 0; i < 30; i++) {
		target = (await activeTargets()).find((candidate) => candidate.labels.instance === instance);
		if (target?.health === "up") return target;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	return target;
}

async function waitForQuery(query: string): Promise<{ status: string; data?: { result?: PrometheusResult[] } }> {
	let last: { status: string; data?: { result?: PrometheusResult[] } } | undefined;
	for (let i = 0; i < 30; i++) {
		last = await queryPrometheus(query);
		if ((last.data?.result?.length ?? 0) > 0) return last;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	return last ?? queryPrometheus(query);
}

d("observability stack - Prometheus live", () => {
	it("scrapes the gRPC metrics target on the shared metrics port", async () => {
		const name = `blok-prom-target-${randomBytes(4).toString("hex")}`;
		const metricsServer = [
			"from http.server import BaseHTTPRequestHandler, HTTPServer",
			"class H(BaseHTTPRequestHandler):",
			"    def log_message(self, *args): pass",
			"    def do_GET(self):",
			"        body = b'# TYPE blok_prom_port_live_test_total counter\\nblok_prom_port_live_test_total 7\\n'",
			"        self.send_response(200)",
			"        self.send_header('Content-Type', 'text/plain; version=0.0.4')",
			"        self.send_header('Content-Length', str(len(body)))",
			"        self.end_headers()",
			"        self.wfile.write(body)",
			"HTTPServer(('0.0.0.0', 9464), H).serve_forever()",
		].join("\n");

		try {
			run("docker", [
				"run",
				"--rm",
				"-d",
				"--name",
				name,
				"--network",
				"shared-network",
				"--network-alias",
				"blok-grpc",
				"python:3.12-alpine",
				"python",
				"-c",
				metricsServer,
			]);

			const target = await waitForTarget("blok-grpc:9464");
			expect(target?.scrapeUrl).toBe("http://blok-grpc:9464/metrics");
			expect(target?.health).toBe("up");

			const up = await waitForQuery('up{job="blok-grpc",instance="blok-grpc:9464"} == 1');
			expect(up.status).toBe("success");
			expect(up.data?.result).toHaveLength(1);
			expect(up.data?.result?.[0]?.value[1]).toBe("1");

			const metric = await waitForQuery("blok_prom_port_live_test_total");
			expect(metric.status).toBe("success");
			expect(metric.data?.result).toHaveLength(1);
			expect(metric.data?.result?.[0]?.value[1]).toBe("7");
		} finally {
			removeContainer(name);
		}
	}, 60_000);
});
