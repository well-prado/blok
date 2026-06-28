import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	BlokResponse,
	BlokService,
	Configuration,
	type GlobalOptions,
	type IBlokResponse,
	WorkflowTestRunner,
} from "@blokjs/runner";
import type { Context } from "@blokjs/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ScannedWorkflow, scanWorkflows } from "../../src/runner/scanWorkflows";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const WORKFLOWS_ROOT = path.join(REPO_ROOT, "triggers/http/workflows");
const JSON_ROOT = path.join(WORKFLOWS_ROOT, "json");
const TS_ROOT = path.join(REPO_ROOT, "triggers/http/src/workflows");

interface CorpusEntry {
	kind: "json" | "ts";
	key: string;
	source: string;
	workflow: unknown;
}

interface LoadedPair {
	current: Configuration;
	preloaded: Configuration;
}

type LoaderOutcome = { ok: true; config: Configuration } | { ok: false; error: string };

class CorpusMockNode extends BlokService<unknown> {
	constructor(nodeName: string) {
		super();
		this.name = nodeName;
	}

	async handle(_ctx: Context, inputs: unknown): Promise<IBlokResponse> {
		const response = new BlokResponse();
		response.setSuccess({ ok: true, inputs } as Record<string, unknown>);
		return response;
	}
}

const originalEnv = {
	WORKFLOWS_PATH: process.env.WORKFLOWS_PATH,
	VITE_WORKFLOWS_PATH: process.env.VITE_WORKFLOWS_PATH,
	WORKFLOWS_FILE_TYPE: process.env.WORKFLOWS_FILE_TYPE,
	VITE_WORKFLOWS_FILE_TYPE: process.env.VITE_WORKFLOWS_FILE_TYPE,
	BLOK_GRPC_HEALTH_INTERVAL_MS: process.env.BLOK_GRPC_HEALTH_INTERVAL_MS,
};

beforeAll(() => {
	process.env.WORKFLOWS_PATH = WORKFLOWS_ROOT;
	clearEnv("VITE_WORKFLOWS_PATH");
	process.env.WORKFLOWS_FILE_TYPE = "json";
	clearEnv("VITE_WORKFLOWS_FILE_TYPE");
	process.env.BLOK_GRPC_HEALTH_INTERVAL_MS = "0";
});

afterAll(() => {
	restoreEnv("WORKFLOWS_PATH", originalEnv.WORKFLOWS_PATH);
	restoreEnv("VITE_WORKFLOWS_PATH", originalEnv.VITE_WORKFLOWS_PATH);
	restoreEnv("WORKFLOWS_FILE_TYPE", originalEnv.WORKFLOWS_FILE_TYPE);
	restoreEnv("VITE_WORKFLOWS_FILE_TYPE", originalEnv.VITE_WORKFLOWS_FILE_TYPE);
	restoreEnv("BLOK_GRPC_HEALTH_INTERVAL_MS", originalEnv.BLOK_GRPC_HEALTH_INTERVAL_MS);
});

function restoreEnv(key: keyof typeof originalEnv, value: string | undefined): void {
	if (value === undefined) clearEnv(key);
	else process.env[key] = value;
}

function clearEnv(key: keyof typeof originalEnv): void {
	Reflect.deleteProperty(process.env, key);
}

async function loadCorpus(): Promise<CorpusEntry[]> {
	const [json, ts] = await Promise.all([
		scanWorkflows([{ dir: JSON_ROOT, kind: "json", stripLeadingSegments: 0 }]),
		scanWorkflows([{ dir: TS_ROOT, kind: "ts", stripLeadingSegments: 0 }]),
	]);

	return [
		...json.map((entry) => toCorpusEntry(entry, JSON_ROOT)),
		...ts.map((entry) => toCorpusEntry(entry, TS_ROOT)),
	].sort((a, b) => `${a.kind}:${a.key}`.localeCompare(`${b.kind}:${b.key}`));
}

function toCorpusEntry(entry: ScannedWorkflow, root: string): CorpusEntry {
	return {
		kind: entry.kind,
		key: keyFromSource(entry.source, root),
		source: entry.source,
		workflow: entry.workflow,
	};
}

function keyFromSource(source: string, root: string): string {
	const rel = path.relative(root, source).replace(/\\/g, "/");
	return rel.replace(/\.(ts|js|json)$/i, "");
}

function makeOptions(entries: readonly CorpusEntry[]): GlobalOptions {
	const nodeCache = new Map<string, CorpusMockNode>();
	const workflows = Object.fromEntries(
		entries
			.filter((entry) => entry.kind === "ts")
			.map((entry) => [entry.key, entry.workflow as { toJson: () => string }]),
	);

	return {
		workflows,
		nodes: {
			getNode(name: string) {
				let node = nodeCache.get(name);
				if (!node) {
					node = new CorpusMockNode(name);
					nodeCache.set(name, node);
				}
				return node;
			},
		},
	} as unknown as GlobalOptions;
}

async function loadBoth(entry: CorpusEntry, options: GlobalOptions): Promise<LoadedPair> {
	const current = new Configuration();
	await withResolverEnv(entry, () => current.init(entry.key, options));

	const preloaded = new Configuration();
	await preloaded.init(entry.key, options, entry.workflow);

	return { current, preloaded };
}

async function loadCurrent(entry: CorpusEntry, options: GlobalOptions): Promise<LoaderOutcome> {
	const config = new Configuration();
	try {
		await withResolverEnv(entry, () => config.init(entry.key, options));
		return { ok: true, config };
	} catch (err) {
		return { ok: false, error: loaderError(err) };
	}
}

async function loadPreloaded(entry: CorpusEntry, options: GlobalOptions): Promise<LoaderOutcome> {
	const config = new Configuration();
	try {
		await config.init(entry.key, options, entry.workflow);
		return { ok: true, config };
	} catch (err) {
		return { ok: false, error: loaderError(err) };
	}
}

function loaderError(err: unknown): string {
	return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function snapshotConfig(config: Configuration): unknown {
	return canonicalPlain({
		name: config.name,
		version: config.version,
		trigger: config.trigger,
		appliedMiddleware: config.appliedMiddleware,
		workflow: config.workflow,
		steps: config.steps.map((step) => canonicalNode(step as unknown as Record<string, unknown>)),
		nodes: canonicalResolved(config.nodes as unknown),
	});
}

function canonicalPlain(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalPlain);
	if (!isRecord(value)) return value;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		const next = value[key];
		if (next === undefined || typeof next === "function") continue;
		out[key] = canonicalPlain(next);
	}
	return out;
}

function canonicalResolved(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalResolved);
	if (!isRecord(value)) return value;
	if (typeof value.process === "function" || typeof value.run === "function") {
		return canonicalNode(value);
	}
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		if (key === "globalOptions") continue;
		const next = value[key];
		if (next === undefined || typeof next === "function") continue;
		out[key] = canonicalResolved(next);
	}
	return out;
}

function canonicalNode(node: Record<string, unknown>): Record<string, unknown> {
	const fields = [
		"name",
		"node",
		"type",
		"runtime",
		"active",
		"stop",
		"flow",
		"contentType",
		"as",
		"spread",
		"ephemeral",
		"idempotencyKey",
		"idempotencyKeyTTL",
		"retry",
		"subworkflow",
		"wait",
		"waitForMs",
		"waitUntil",
		"maxDurationMs",
		"stream_logs",
		"streamTo",
		"stream",
		"transport",
		"allowList",
		"dispatch",
		"namespace",
		"isPrimitiveIterator",
	] as const;
	const out: Record<string, unknown> = { className: node.constructor?.name };
	for (const field of fields) {
		const value = node[field];
		if (value !== undefined && typeof value !== "function") out[field] = canonicalResolved(value);
	}
	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function toWorkflowTestRunnerInput(config: Configuration): { name: string; steps: Array<Record<string, unknown>> } {
	const nodes = config.nodes as Record<string, { inputs?: unknown } | undefined>;
	return {
		name: config.name,
		steps: config.steps.map((step) => {
			const s = step as unknown as { name: string; node: string };
			return {
				name: s.name,
				node: s.node,
				inputs: nodes[s.name]?.inputs ?? {},
			};
		}),
	};
}

async function runWorkflowTestTrace(config: Configuration): Promise<unknown> {
	const runner = new WorkflowTestRunner({ mockAllNodes: true, timeout: 2000 });
	runner.loadWorkflow(toWorkflowTestRunnerInput(config));
	const result = await runner.execute(
		{
			value: "fixture",
			type: "countries",
			items: [{ id: "a", query: "alpha" }],
			rows: [{ id: "row-1" }],
		},
		{
			headers: {
				"x-github-event": "push",
				"x-tenant-id": "acme",
			},
			query: { type: "countries" },
		},
	);
	expect(result.success).toBe(true);
	return result.trace.map(({ durationMs: _durationMs, timestamp: _timestamp, ...stable }) => stable);
}

async function withWorkflowRoot<T>(root: string, fn: () => Promise<T>): Promise<T> {
	const previous = process.env.WORKFLOWS_PATH;
	process.env.WORKFLOWS_PATH = root;
	try {
		return await fn();
	} finally {
		restoreEnv("WORKFLOWS_PATH", previous);
	}
}

async function withResolverEnv<T>(entry: CorpusEntry, fn: () => Promise<T>): Promise<T> {
	const previousPath = process.env.WORKFLOWS_PATH;
	const previousVitePath = process.env.VITE_WORKFLOWS_PATH;
	const previousType = process.env.WORKFLOWS_FILE_TYPE;
	const previousViteType = process.env.VITE_WORKFLOWS_FILE_TYPE;
	process.env.WORKFLOWS_PATH = entry.kind === "json" ? jsonWorkflowRoot(entry) : TS_ROOT;
	clearEnv("VITE_WORKFLOWS_PATH");
	process.env.WORKFLOWS_FILE_TYPE = entry.kind === "json" ? "json" : "ts";
	clearEnv("VITE_WORKFLOWS_FILE_TYPE");
	try {
		return await fn();
	} finally {
		restoreEnv("WORKFLOWS_PATH", previousPath);
		restoreEnv("VITE_WORKFLOWS_PATH", previousVitePath);
		restoreEnv("WORKFLOWS_FILE_TYPE", previousType);
		restoreEnv("VITE_WORKFLOWS_FILE_TYPE", previousViteType);
	}
}

function jsonWorkflowRoot(entry: CorpusEntry): string {
	let root = entry.source;
	for (let i = 0; i < entry.key.split("/").length + 1; i++) {
		root = path.dirname(root);
	}
	return root;
}

describe("workflow loader equivalence gate", () => {
	it("loads every shipped TS and JSON workflow through resolver and preloaded paths with identical resolved IR", async () => {
		const entries = await loadCorpus();
		expect(entries.filter((entry) => entry.kind === "json").length).toBeGreaterThan(0);
		expect(entries.filter((entry) => entry.kind === "ts").length).toBeGreaterThan(0);

		const options = makeOptions(entries);
		const failures: string[] = [];
		for (const entry of entries) {
			const current = await loadCurrent(entry, options);
			const preloaded = await loadPreloaded(entry, options);
			if (!current.ok || !preloaded.ok) {
				if (current.ok !== preloaded.ok || current.error !== preloaded.error) {
					failures.push(
						`${entry.kind}:${entry.key} (${entry.source}) current=${outcomeLabel(current)} preloaded=${outcomeLabel(preloaded)}`,
					);
				}
				continue;
			}
			const a = JSON.stringify(snapshotConfig(current.config));
			const b = JSON.stringify(snapshotConfig(preloaded.config));
			if (a !== b) failures.push(`${entry.kind}:${entry.key} (${entry.source})`);
		}

		expect(failures).toEqual([]);
	}, 30_000);

	it("produces identical mocked WorkflowTestRunner traces for representative corpus workflows", async () => {
		const entries = await loadCorpus();
		const options = makeOptions(entries);
		const byId = new Map(entries.map((entry) => [`${entry.kind}:${entry.key}`, entry]));
		const ids = ["json:countries", "json:v05-event-router", "ts:eval/eval-run"];

		for (const id of ids) {
			const entry = byId.get(id);
			expect(entry, `missing representative workflow ${id}`).toBeDefined();
			if (!entry) continue;
			const { current, preloaded } = await loadBoth(entry, options);
			await expect(runWorkflowTestTrace(preloaded), id).resolves.toEqual(await runWorkflowTestTrace(current));
		}
	}, 20_000);

	it("keeps legacy JSON extra fields and spread/as/ephemeral persistence knobs equivalent", async () => {
		const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "blok-loader-equivalence-"));
		try {
			await fsp.mkdir(path.join(tmpRoot, "json"), { recursive: true });
			const workflow = {
				name: "loader.edge",
				version: "1.0.0",
				description: "Synthetic loader-equivalence edge workflow",
				extraIgnoredByNormalizer: { shouldNotReject: true },
				trigger: { http: { method: "POST", path: "/loader-edge" } },
				steps: [
					{ name: "legacy-expr", node: "@blokjs/expr", type: "module", extraStepField: "ignored" },
					{ id: "renamed", use: "@blokjs/expr", as: "renamedState", inputs: { expression: "(() => 1)()" } },
					{ id: "spread-out", use: "@blokjs/expr", spread: true, inputs: { expression: "({ a: 1 })" } },
					{ id: "secret", use: "@blokjs/expr", ephemeral: true, inputs: { expression: "ctx.request.body.secret" } },
				],
				nodes: {
					"legacy-expr": {
						inputs: { expression: "(() => ctx.request.body.value)()" },
						extraNodeField: "kept",
					},
				},
			};
			await fsp.writeFile(path.join(tmpRoot, "json", "loader-edge.json"), JSON.stringify(workflow));

			await withWorkflowRoot(tmpRoot, async () => {
				const entry: CorpusEntry = {
					kind: "json",
					key: "loader-edge",
					source: path.join(tmpRoot, "json", "loader-edge.json"),
					workflow,
				};
				const { current, preloaded } = await loadBoth(entry, makeOptions([entry]));
				expect(snapshotConfig(preloaded)).toEqual(snapshotConfig(current));
			});
		} finally {
			await fsp.rm(tmpRoot, { recursive: true, force: true });
		}
	}, 20_000);
});

function outcomeLabel(outcome: LoaderOutcome): string {
	return outcome.ok ? "ok" : outcome.error;
}
