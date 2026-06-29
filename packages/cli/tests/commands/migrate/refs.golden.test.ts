import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrateJsonWorkflow } from "../../../src/commands/migrate/refs.js";

// #396 merged branch.when migration into migrateJsonWorkflow and broadened this
// marker. Keep in sync with MARKER in src/commands/migrate/refs.ts.
const MARKER = "blok-migrate: hand-migrate (dynamic expression / branch.when not handle-safe)";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const fixtures = path.resolve(here, "../../fixtures/migrate-refs");

interface GoldenCase {
	input: string;
	expected: string;
	real?: boolean;
	buckets: string[];
	migrated: number;
	marked: number;
	markedInputs: string[];
}

const CASES: GoldenCase[] = [
	{
		input: "triggers/http/workflows/json/agent-message.json",
		expected: "agent-message.json",
		real: true,
		buckets: ["pure-template", "dynamic-js", "expr-input", "ephemeral"],
		migrated: 3,
		marked: 4,
		markedInputs: ["agent::apiKey", "agent::messages", "agent::model", "save-history::value"],
	},
	{
		input: "triggers/http/workflows/json/chat-message.json",
		expected: "chat-message.json",
		real: true,
		buckets: ["pure-path", "dynamic-js"],
		migrated: 2,
		marked: 2,
		markedInputs: ["stream::apiKey", "stream::model"],
	},
	{
		input: "triggers/http/workflows/json/webhook-github.json",
		expected: "webhook-github.json",
		real: true,
		buckets: ["pure-path", "dynamic-js", "control-field", "expr-input"],
		migrated: 2,
		marked: 8,
		markedInputs: [
			"route-by-event>dispatch-issues::action",
			"route-by-event>dispatch-issues::issue",
			"route-by-event>dispatch-pr::action",
			"route-by-event>dispatch-pr::pull_request",
			"route-by-event>dispatch-push::commits",
			"route-by-event>dispatch-push::ref",
			"route-by-event>dispatch-push::repo",
			"route-by-event>log-unknown::message",
		],
	},
	{
		input: "triggers/http/workflows/json/webhook-github-issues.json",
		expected: "webhook-github-issues.json",
		real: true,
		buckets: ["expr-input"],
		migrated: 0,
		marked: 0,
		markedInputs: [],
	},
	{
		input: "triggers/http/workflows/json/webhook-github-pr.json",
		expected: "webhook-github-pr.json",
		real: true,
		buckets: ["expr-input"],
		migrated: 0,
		marked: 0,
		markedInputs: [],
	},
	{
		input: "triggers/http/workflows/json/webhook-github-push.json",
		expected: "webhook-github-push.json",
		real: true,
		buckets: ["dynamic-js", "expr-input", "ephemeral"],
		migrated: 0,
		marked: 1,
		markedInputs: ["log::message"],
	},
	{
		input: "triggers/http/workflows/json/webhook-stripe.json",
		expected: "webhook-stripe.json",
		real: true,
		buckets: ["pure-path", "key-field", "control-field"],
		migrated: 1,
		marked: 0,
		markedInputs: [],
	},
	{
		input: "triggers/http/workflows/json/webhook-stripe-invoice-paid.json",
		expected: "webhook-stripe-invoice-paid.json",
		real: true,
		buckets: ["dynamic-js", "expr-input", "ephemeral"],
		migrated: 0,
		marked: 1,
		markedInputs: ["log::message"],
	},
	{
		input: "triggers/http/workflows/json/webhook-stripe-customer-created.json",
		expected: "webhook-stripe-customer-created.json",
		real: true,
		buckets: ["expr-input"],
		migrated: 0,
		marked: 0,
		markedInputs: [],
	},
	{
		input: "triggers/http/workflows/json/countries-vs-facts.json",
		expected: "countries-vs-facts.json",
		real: true,
		buckets: ["control-field"],
		migrated: 0,
		marked: 0,
		markedInputs: [],
	},
	{
		input: "triggers/http/workflows/json/v05-nested-control-flow.json",
		expected: "v05-nested-control-flow.json",
		real: true,
		buckets: ["pure-path", "dynamic-js", "control-field", "expr-input", "as-field"],
		migrated: 9,
		marked: 3,
		markedInputs: [
			"per-item-pipeline>item-tryCatch>audit-item-failure::reason",
			"per-item-pipeline>item-tryCatch>decide-on-failure>rethrow-required::message",
			"per-item-pipeline>item-tryCatch>decide-on-failure>skip-and-log::message",
		],
	},
	{
		input: "triggers/http/workflows/json/v05-user-signup-saga.json",
		expected: "v05-user-signup-saga.json",
		real: true,
		buckets: ["pure-path", "dynamic-js", "control-field", "expr-input"],
		migrated: 10,
		marked: 6,
		markedInputs: [
			"signup-saga>create-profile::url",
			"signup-saga>respond-failed::body.errorName",
			"signup-saga>respond-failed::body.failedAt",
			"signup-saga>respond-failed::body.reason",
			"signup-saga>respond-failed::body.rolledBack",
			"signup-saga>respond-failed::body.upstreamCode",
		],
	},
	{
		input: "triggers/http/workflows/json/v05-travel-booking.json",
		expected: "v05-travel-booking.json",
		real: true,
		buckets: ["pure-path", "dynamic-js", "control-field", "expr-input"],
		migrated: 7,
		marked: 8,
		markedInputs: [
			"saga>book-car::body.passenger",
			"saga>book-flight::body.passenger",
			"saga>book-hotel::body.passenger",
			"saga>respond-failed::body.compensated.car",
			"saga>respond-failed::body.compensated.flight",
			"saga>respond-failed::body.compensated.hotel",
			"saga>respond-failed::body.failedAt",
			"saga>respond-failed::body.reason",
		],
	},
	{
		input: "triggers/http/workflows/json/v05-order-fulfillment.json",
		expected: "v05-order-fulfillment.json",
		real: true,
		buckets: ["pure-path", "dynamic-js", "control-field", "expr-input", "as-field"],
		migrated: 12,
		marked: 1,
		markedInputs: ["charge-payment>record-failure::value"],
	},
	{
		input: "triggers/http/workflows/json/v05-csv-import.json",
		expected: "v05-csv-import.json",
		real: true,
		buckets: ["pure-path", "dynamic-js", "control-field", "expr-input", "as-field"],
		migrated: 4,
		marked: 3,
		markedInputs: [
			"process-rows>row-tryCatch>capture-row-error::value",
			"process-rows>row-tryCatch>insert-row::url",
			"process-rows>row-tryCatch>log-failed-row::message",
		],
	},
	{
		input: "triggers/http/workflows/json/v05-data-export.json",
		expected: "v05-data-export.json",
		real: true,
		buckets: ["pure-path", "dynamic-js", "control-field", "expr-input", "as-field"],
		migrated: 4,
		marked: 2,
		markedInputs: [
			"fetch-pages>page-tryCatch>audit-page-failure::reason",
			"fetch-pages>page-tryCatch>capture-page-error::value",
		],
	},
	{
		input: "packages/cli/tests/fixtures/migrate-refs/input/spread-as-ephemeral.json",
		expected: "spread-as-ephemeral.json",
		buckets: ["pure-path", "dynamic-js", "control-field", "as-field", "spread", "ephemeral"],
		migrated: 4,
		marked: 2,
		markedInputs: ["after-scratch::prev", "mixed-template::message"],
	},
];

describe("migrateRefs golden corpus", () => {
	it("pins real workflow outputs, coverage counts, marked inputs, and idempotency", () => {
		const report: Record<string, { migrated: number; marked: number }> = {};

		for (const testCase of CASES) {
			const input = readJson(path.resolve(repoRoot, testCase.input));
			const expected = readJson(path.resolve(fixtures, "expected", testCase.expected));
			const result = migrateJsonWorkflow(input);
			const idempotent = migrateJsonWorkflow(result.value);

			report[testCase.expected] = result.stats;
			expect(result.value, testCase.input).toEqual(expected);
			expect(result.stats, testCase.input).toEqual({ migrated: testCase.migrated, marked: testCase.marked });
			expect(idempotent.value, testCase.input).toEqual(result.value);
			expect(idempotent.stats, testCase.input).toEqual({ migrated: 0, marked: 0 });
			expect(collectMarkedInputs(result.value), testCase.input).toEqual([...testCase.markedInputs].sort());
			expect(
				collectPurePathInputs(result.value).filter((input) => !testCase.markedInputs.includes(input)),
				testCase.input,
			).toEqual([]);

			for (const markedInput of testCase.markedInputs) {
				expect(inputValue(input, markedInput), markedInput).toBe(inputValue(result.value, markedInput));
			}
			for (const excludedPath of collectExcludedPaths(input)) {
				expect(getAtPath(result.value, excludedPath), excludedPath.join(".")).toEqual(getAtPath(input, excludedPath));
			}
		}

		expect(CASES.filter((testCase) => testCase.real).length).toBeGreaterThanOrEqual(15);
		expect([...new Set(CASES.flatMap((testCase) => testCase.buckets))].sort()).toEqual([
			"as-field",
			"control-field",
			"dynamic-js",
			"ephemeral",
			"expr-input",
			"key-field",
			"pure-path",
			"pure-template",
			"spread",
		]);
		expect(report).toEqual(
			Object.fromEntries(
				CASES.map((testCase) => [testCase.expected, { migrated: testCase.migrated, marked: testCase.marked }]),
			),
		);
	});
});

function readJson(file: string): unknown {
	return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function collectMarkedInputs(workflow: unknown): string[] {
	const marked: string[] = [];
	walkSteps(workflow, (step, trail) => {
		if (!hasMarker(step) || !isPlainObject(step.inputs)) return;
		walkValue(step.inputs, (value, inputPath) => {
			if (typeof value === "string" && value.startsWith("js/")) marked.push(inputKey(trail, inputPath));
		});
	});
	return marked.sort();
}

function collectPurePathInputs(workflow: unknown): string[] {
	const pure: string[] = [];
	walkSteps(workflow, (step, trail) => {
		if (!isPlainObject(step.inputs)) return;
		walkValue(step.inputs, (value, inputPath) => {
			if (typeof value === "string" && isPurePath(value)) pure.push(inputKey(trail, inputPath));
		});
	});
	return pure.sort();
}

function collectExcludedPaths(value: unknown, pathParts: (string | number)[] = []): (string | number)[][] {
	if (Array.isArray(value)) {
		return value.flatMap((item, index) => collectExcludedPaths(item, [...pathParts, index]));
	}
	if (!isPlainObject(value)) return [];

	const out: (string | number)[][] = [];
	for (const [key, child] of Object.entries(value)) {
		const childPath = [...pathParts, key];
		if (isExcludedField(key, pathParts)) out.push(childPath);
		out.push(...collectExcludedPaths(child, childPath));
	}
	return out;
}

function isExcludedField(key: string, parentPath: (string | number)[]): boolean {
	const parent = parentPath[parentPath.length - 1];
	if (key === "idempotencyKey" || key === "concurrencyKey" || key === "subworkflow") return true;
	if (key === "key" && parent === "debounce") return true;
	if (key === "expression" && parent === "inputs") return true;
	if (key === "in" && parent === "forEach") return true;
	// #396: branch.when is migrated (ctx.x === true → ctx.x), so it is NOT
	// byte-identical. Switch-case `when` and trigger `on` filters still are.
	if (key === "when" && parent !== "branch") return true;
	if (key === "on") return true;
	return false;
}

function inputValue(workflow: unknown, key: string): unknown {
	const [trailRaw, inputRaw] = key.split("::");
	const step = findStep(workflow, trailRaw.split(">"));
	if (!step || !isPlainObject(step.inputs)) throw new Error(`Missing step inputs for ${key}`);
	return getAtPath(step.inputs, inputRaw.split("."));
}

function walkSteps(
	workflowOrSteps: unknown,
	fn: (step: Record<string, unknown>, trail: string[]) => void,
	trail: string[] = [],
): void {
	const steps = Array.isArray(workflowOrSteps)
		? workflowOrSteps
		: isPlainObject(workflowOrSteps)
			? workflowOrSteps.steps
			: undefined;
	if (!Array.isArray(steps)) return;
	for (const step of steps) {
		if (!isPlainObject(step)) continue;
		const nextTrail = [...trail, stepId(step)];
		fn(step, nextTrail);
		if (isPlainObject(step.branch)) {
			walkSteps(step.branch.then, fn, nextTrail);
			walkSteps(step.branch.else, fn, nextTrail);
		}
		if (isPlainObject(step.forEach)) walkSteps(step.forEach.do, fn, nextTrail);
		if (isPlainObject(step.loop)) walkSteps(step.loop.do, fn, nextTrail);
		if (isPlainObject(step.tryCatch)) {
			walkSteps(step.tryCatch.try, fn, nextTrail);
			walkSteps(step.tryCatch.catch, fn, nextTrail);
			walkSteps(step.tryCatch.finally, fn, nextTrail);
		}
		if (isPlainObject(step.switch)) {
			walkSteps(step.switch.default, fn, nextTrail);
			if (Array.isArray(step.switch.cases)) {
				for (const switchCase of step.switch.cases) {
					if (!isPlainObject(switchCase)) continue;
					walkSteps(switchCase.steps, fn, nextTrail);
					walkSteps(switchCase.do, fn, nextTrail);
				}
			}
		}
	}
}

function findStep(workflow: unknown, trail: string[]): Record<string, unknown> | undefined {
	let found: Record<string, unknown> | undefined;
	walkSteps(workflow, (step, currentTrail) => {
		if (currentTrail.join(">") === trail.join(">")) found = step;
	});
	return found;
}

function walkValue(value: unknown, fn: (value: unknown, path: string[]) => void, pathParts: string[] = []): void {
	if (Array.isArray(value)) {
		value.forEach((item, index) => walkValue(item, fn, [...pathParts, String(index)]));
		return;
	}
	if (isPlainObject(value)) {
		for (const [key, child] of Object.entries(value)) walkValue(child, fn, [...pathParts, key]);
		return;
	}
	fn(value, pathParts);
}

function getAtPath(value: unknown, pathParts: (string | number)[]): unknown {
	return pathParts.reduce<unknown>((current, part) => {
		if (!isPlainObject(current) && !Array.isArray(current)) return undefined;
		return (current as Record<string, unknown> | unknown[])[part as never];
	}, value);
}

function inputKey(trail: string[], inputPath: string[]): string {
	return `${trail.join(">")}::${inputPath.join(".")}`;
}

function stepId(step: Record<string, unknown>): string {
	return String(step.id ?? step.name ?? "<anonymous>");
}

function hasMarker(step: Record<string, unknown>): boolean {
	return isPlainObject(step.ui) && typeof step.ui.notes === "string" && step.ui.notes.includes(MARKER);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPurePath(value: string): boolean {
	const segment = String.raw`(?:\.[A-Za-z_$][\w$]*|\[['"][^'"]+['"]\]|\[\d+\])`;
	const roots = String.raw`(?:ctx\.(?:state|vars|request|req|prev|response)|\$\.(?:state|vars|request|req|prev|response))`;
	return new RegExp(String.raw`^(?:js/)?${roots}${segment}*$`).test(value);
}
