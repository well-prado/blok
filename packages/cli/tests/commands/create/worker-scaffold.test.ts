import os from "node:os";
import path from "node:path";
import fsExtra from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProviderDependencies, getProviderEnvVars, updateQueueProvider } from "../../../src/commands/create/project";

/**
 * Regression tests for Bug 02 — the worker scaffold must NOT hardcode a broker
 * adapter (Kafka) by default. With no explicit provider it leaves the commented
 * resolution block (so `this.adapter` stays undefined → framework resolves
 * provider → BLOK_WORKER_ADAPTER → in-memory), writes BLOK_WORKER_ADAPTER=in-memory
 * instead of a KAFKA_* block, and adds no broker deps. Only an explicit provider
 * injects an active adapter + its env + its dependency.
 */

// Mirrors the shipped template's WorkerServer.ts (triggers/worker/template):
// only `{ WorkerTrigger }` is imported and there is NO active
// `protected adapter = …` assignment — only a commented example.
const TEMPLATE_WORKER_SERVER = `import { WorkerTrigger } from "@blokjs/trigger-worker";
import nodes from "../Nodes";
import workflows from "../Workflows";

/**
 * WorkerServer
 *
 *   import { NATSWorkerAdapter } from "@blokjs/trigger-worker";
 *   protected adapter = new NATSWorkerAdapter({
 *     servers: (process.env.NATS_SERVERS || "localhost:4222").split(","),
 *   });
 */
export default class WorkerServer extends WorkerTrigger {
	protected nodes: Record<string, import("@blokjs/runner").BlokService<unknown>> = nodes;
	protected workflows: Record<string, import("@blokjs/helper").WorkflowV2Builder> = workflows;
}
`;

// Count only ACTIVE class-property assignments (a line that begins with optional
// whitespace then `protected adapter = new`). JSDoc/comment example lines start
// with `*` or `//` and must not be counted.
function countActiveAdapterAssignments(content: string): number {
	return content.split("\n").filter((line) => /^\s*protected adapter = new /.test(line)).length;
}

describe("worker scaffold — adapter injection (Bug 02)", () => {
	let triggerDestDir: string;

	beforeEach(() => {
		triggerDestDir = fsExtra.mkdtempSync(path.join(os.tmpdir(), "blok-worker-scaffold-"));
		fsExtra.ensureDirSync(path.join(triggerDestDir, "runner"));
		fsExtra.writeFileSync(path.join(triggerDestDir, "runner", "WorkerServer.ts"), TEMPLATE_WORKER_SERVER);
	});

	afterEach(() => {
		fsExtra.removeSync(triggerDestDir);
	});

	it("leaves NO active adapter assignment when not explicit (still imports/extends WorkerTrigger)", () => {
		updateQueueProvider(triggerDestDir, "kafka", false);
		const content = fsExtra.readFileSync(path.join(triggerDestDir, "runner", "WorkerServer.ts"), "utf8");

		expect(countActiveAdapterAssignments(content)).toBe(0);
		expect(content).toContain('import { WorkerTrigger } from "@blokjs/trigger-worker";');
		expect(content).toContain("extends WorkerTrigger");
		// No broker adapter import was injected.
		expect(content).not.toContain("KafkaAdapter");
	});

	it("injects exactly one active NATSWorkerAdapter when explicit, provider=nats", () => {
		updateQueueProvider(triggerDestDir, "nats", true);
		const content = fsExtra.readFileSync(path.join(triggerDestDir, "runner", "WorkerServer.ts"), "utf8");

		expect(countActiveAdapterAssignments(content)).toBe(1);
		expect(content).toContain("protected adapter = new NATSWorkerAdapter(");
		expect(content).toContain('import { NATSWorkerAdapter, WorkerTrigger } from "@blokjs/trigger-worker";');
	});

	it("injects a Kafka adapter when explicit, provider=kafka", () => {
		updateQueueProvider(triggerDestDir, "kafka", true);
		const content = fsExtra.readFileSync(path.join(triggerDestDir, "runner", "WorkerServer.ts"), "utf8");

		expect(countActiveAdapterAssignments(content)).toBe(1);
		expect(content).toContain("protected adapter = new KafkaAdapter(");
		expect(content).toContain('import { KafkaAdapter, WorkerTrigger } from "@blokjs/trigger-worker";');
	});
});

describe("worker scaffold — .env gating (Bug 02)", () => {
	it("writes BLOK_WORKER_ADAPTER=in-memory and no KAFKA_* when not explicit", () => {
		const env = getProviderEnvVars(["worker"], "gcp", "kafka", false);
		expect(env).toContain("BLOK_WORKER_ADAPTER=in-memory");
		expect(env).not.toContain("KAFKA_BROKERS=");
	});

	it("writes the KAFKA_* block when explicit kafka was chosen", () => {
		const env = getProviderEnvVars(["queue"], "gcp", "kafka", true);
		expect(env).toContain("KAFKA_BROKERS=");
		expect(env).not.toContain("BLOK_WORKER_ADAPTER=in-memory");
	});

	it("writes nothing worker-related for an HTTP-only project", () => {
		const env = getProviderEnvVars(["http"], "gcp", "kafka", false);
		expect(env).not.toContain("BLOK_WORKER_ADAPTER=in-memory");
		expect(env).not.toContain("KAFKA_BROKERS=");
	});
});

describe("worker scaffold — dependency gating (Bug 02)", () => {
	it("does NOT add kafkajs when no explicit provider was chosen", () => {
		const deps = getProviderDependencies(["worker"], "gcp", "kafka", false);
		expect(deps.kafkajs).toBeUndefined();
	});

	it("adds kafkajs when explicit kafka was chosen", () => {
		const deps = getProviderDependencies(["queue"], "gcp", "kafka", true);
		expect(deps.kafkajs).toBe("^2.2.4");
	});
});

/**
 * End-to-end-ish check of the no-provider path the way a non-interactive
 * `createProject({ triggers: "http,worker" })` exercises it: the scaffolded
 * WorkerServer has no active `this.adapter`, the env defaults to in-memory, and
 * no broker dep is pulled in. Done with the exported helpers against a temp dir
 * so it stays deterministic (no network clone / npm install).
 */
describe("worker scaffold — http,worker without --queue-provider (Bug 02)", () => {
	let triggerDestDir: string;

	beforeEach(() => {
		triggerDestDir = fsExtra.mkdtempSync(path.join(os.tmpdir(), "blok-http-worker-"));
		fsExtra.ensureDirSync(path.join(triggerDestDir, "runner"));
		fsExtra.writeFileSync(path.join(triggerDestDir, "runner", "WorkerServer.ts"), TEMPLATE_WORKER_SERVER);
	});

	afterEach(() => {
		fsExtra.removeSync(triggerDestDir);
	});

	it("scaffolds an in-memory-resolvable worker with no active adapter", () => {
		const explicit = false; // Boolean(opts.queueProvider) with no flag.
		updateQueueProvider(triggerDestDir, "kafka", explicit);
		const server = fsExtra.readFileSync(path.join(triggerDestDir, "runner", "WorkerServer.ts"), "utf8");
		const env = getProviderEnvVars(["http", "worker"], "gcp", "kafka", explicit);
		const deps = getProviderDependencies(["http", "worker"], "gcp", "kafka", explicit);

		expect(countActiveAdapterAssignments(server)).toBe(0);
		expect(env).toContain("BLOK_WORKER_ADAPTER=in-memory");
		expect(env).not.toContain("KAFKA_BROKERS=");
		expect(deps.kafkajs).toBeUndefined();
	});
});
