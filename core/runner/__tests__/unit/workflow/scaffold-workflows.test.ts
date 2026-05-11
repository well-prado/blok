/**
 * Scaffold workflow regression test.
 *
 * Every TS + JSON workflow shipped to a scaffolded project must use the v2
 * step shape. This is the canary that catches a future PR accidentally
 * re-introducing v1 patterns into the scaffold seed.
 *
 * - JSON: parsed + normalized via `normalizeWorkflow` (full structural check).
 * - TS:   text-level check — contains v2 import + v2 step shape, does NOT
 *         contain v1 builder DSL. Normalizing across workspace boundaries
 *         requires loading via vitest's TS pipeline which is brittle for
 *         siblings — text-grep is sufficient as a regression gate, since
 *         each trigger package runs its own test suite for runtime checks.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeWorkflow } from "../../../src/workflow/WorkflowNormalizer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../../../..");

interface ScaffoldWorkflow {
	label: string;
	relPath: string;
	expectedTrigger: "http" | "sse" | "worker" | "pubsub";
}

const TS_WORKFLOWS: ScaffoldWorkflow[] = [
	{
		label: "HTTP / countries-helper",
		relPath: "triggers/http/src/workflows/countries-helper.ts",
		expectedTrigger: "http",
	},
	{
		label: "HTTP / countries-cats-helper",
		relPath: "triggers/http/src/workflows/countries-cats-helper.ts",
		expectedTrigger: "http",
	},
	{
		label: "HTTP / empty",
		relPath: "triggers/http/src/workflows/empty.ts",
		expectedTrigger: "http",
	},
	// SSE scaffold workflows removed in v0.7 PR 3 — the standalone SSE
	// server template is gone (the trigger now mounts on the shared
	// Hono port via SSETrigger). SSE workflows live alongside HTTP and
	// WebSocket workflows in `triggers/http/workflows/json/`.
	{
		label: "Worker / process-job",
		relPath: "triggers/worker/template/src/workflows/jobs/process-job.ts",
		expectedTrigger: "worker",
	},
	// Queue scaffold workflows removed in v0.7 PR 5 — per Q1 resolution
	// there's no standalone queue trigger; the existing WorkerTrigger
	// gained 5 new adapters (kafka/rabbitmq/sqs/redis/pg-boss) instead.
	// The `queue` trigger scaffold + template is gone too.
	{
		label: "Pub-Sub / on-message",
		relPath: "triggers/pubsub/template/src/workflows/messages/on-message.ts",
		expectedTrigger: "pubsub",
	},
];

const JSON_WORKFLOWS: ScaffoldWorkflow[] = [
	{
		label: "Root / countries.json (--examples)",
		relPath: "workflows/json/countries.json",
		expectedTrigger: "http",
	},
	{
		label: "Root / countries-vs-facts.json (--examples)",
		relPath: "workflows/json/countries-vs-facts.json",
		expectedTrigger: "http",
	},
	{
		label: "Root / weather.json (--examples)",
		relPath: "workflows/json/weather.json",
		expectedTrigger: "http",
	},
];

function loadJsonWorkflow(absPath: string): unknown {
	return JSON.parse(readFileSync(absPath, "utf-8")) as unknown;
}

function readSource(absPath: string): string {
	return readFileSync(absPath, "utf-8");
}

function assertJsonV2Shape(raw: unknown, label: string): void {
	const wf = raw as { steps?: unknown[]; nodes?: unknown };
	if (!Array.isArray(wf.steps)) {
		throw new Error(`${label}: missing or non-array \`steps\``);
	}
	if (wf.nodes !== undefined) {
		throw new Error(`${label}: legacy v1 \`nodes\` map present — should be inline on each step's \`inputs\``);
	}
	for (const [i, s] of wf.steps.entries()) {
		const step = s as Record<string, unknown>;
		if (step.branch !== undefined) continue;
		if (step.subworkflow !== undefined) continue;
		if (step.wait !== undefined) continue;
		if (typeof step.id !== "string") {
			throw new Error(`${label}: step[${i}] missing \`id\` (v1 \`name\` is the legacy shape)`);
		}
		if (typeof step.use !== "string") {
			throw new Error(`${label}: step[${i}] missing \`use\` (v1 \`node\` is the legacy shape)`);
		}
	}
}

describe("scaffold TS workflows — v2 shape regression", () => {
	for (const wf of TS_WORKFLOWS) {
		describe(wf.label, () => {
			it("file exists", () => {
				const abs = path.join(REPO_ROOT, wf.relPath);
				expect(existsSync(abs), `expected ${abs} to exist`).toBe(true);
			});

			it("imports the v2 `workflow` function from @blokjs/helper", () => {
				const src = readSource(path.join(REPO_ROOT, wf.relPath));
				expect(src).toMatch(/import\s+\{[^}]*\bworkflow\b[^}]*\}\s+from\s+"@blokjs\/helper"/);
			});

			it("does NOT use the v1 builder DSL", () => {
				const src = readSource(path.join(REPO_ROOT, wf.relPath));
				expect(src).not.toMatch(/import\s+\{[^}]*\bWorkflow\b[^}]*\}\s+from\s+"@blokjs\/helper"/);
				expect(src).not.toMatch(/\.addTrigger\(/);
				expect(src).not.toMatch(/\.addStep\(/);
				expect(src).not.toMatch(/\.addCondition\(/);
			});

			it("uses the v2 `trigger:` config shape", () => {
				const src = readSource(path.join(REPO_ROOT, wf.relPath));
				expect(src).toMatch(/\btrigger\s*:\s*\{/);
				expect(src).toMatch(new RegExp(`\\b${wf.expectedTrigger}\\s*:\\s*\\{`));
			});

			it("uses the v2 `id:` / `use:` step shape (not v1 `name:` / `node:`)", () => {
				const src = readSource(path.join(REPO_ROOT, wf.relPath));
				const stepHas =
					/\bid\s*:\s*["']/.test(src) ||
					/\bbranch\s*:\s*\{/.test(src) ||
					/\bsubworkflow\s*:\s*["']/.test(src) ||
					/\bwait\s*:\s*\{/.test(src);
				expect(stepHas, "no v2 step (id / branch / subworkflow / wait) found").toBe(true);
				const v1StepShape = /\bnode\s*:\s*"@blokjs/.test(src);
				expect(v1StepShape, "v1 `node:` step shape detected — should be `use:` in v2").toBe(false);
			});
		});
	}
});

describe("scaffold JSON workflows — v2 shape regression", () => {
	for (const wf of JSON_WORKFLOWS) {
		describe(wf.label, () => {
			it("file exists", () => {
				const abs = path.join(REPO_ROOT, wf.relPath);
				expect(existsSync(abs), `expected ${abs} to exist`).toBe(true);
			});

			it("parses as v2 JSON shape", () => {
				const abs = path.join(REPO_ROOT, wf.relPath);
				const raw = loadJsonWorkflow(abs);
				assertJsonV2Shape(raw, wf.label);
			});

			it("normalizes cleanly via normalizeWorkflow", () => {
				const abs = path.join(REPO_ROOT, wf.relPath);
				const raw = loadJsonWorkflow(abs);
				const normalized = normalizeWorkflow(raw, wf.relPath);
				expect(normalized, `${wf.label} did not normalize`).toBeDefined();
				expect(normalized.steps.length, `${wf.label} normalized steps is empty`).toBeGreaterThan(0);
			});

			it("trigger.http.path is present (v0.4 explicit-paths)", () => {
				const abs = path.join(REPO_ROOT, wf.relPath);
				const raw = loadJsonWorkflow(abs) as { trigger?: { http?: { path?: string } } };
				expect(raw.trigger?.http?.path, `${wf.label} missing trigger.http.path`).toBeDefined();
				expect(raw.trigger?.http?.path?.startsWith("/")).toBe(true);
			});
		});
	}
});
