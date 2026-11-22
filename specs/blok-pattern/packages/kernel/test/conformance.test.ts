// The shared tests in conformance/cases, run against this kernel. The Python kernel runs the same files.
// With BLOK_CONFORMANCE_WRITE=1 it also rewrites what is derived: the request shape the check works out for
// every workflow, and the grid of run times taken from the cron library croner.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cron } from "croner";
import { answer, signed } from "../src/http.ts";
import {
	BlokError,
	type HttpBinding,
	type JsonSchema,
	type Signature,
	type Span,
	type Unit,
	type Workflow,
	checkWorkflows,
	httpBinding,
	nextRun,
	parseSchedule,
	workflowId,
	workflowUnit,
} from "../src/index.ts";
import { freshPorts, nodes, runtime } from "./conformance/nodes.ts";

const DIR = join(import.meta.dirname, "..", "..", "..", "conformance", "cases");
const WRITE = process.env.BLOK_CONFORMANCE_WRITE === "1";
const read = <T>(file: string): T => JSON.parse(readFileSync(join(DIR, file), "utf8")) as T;
const write = (file: string, value: unknown) =>
	writeFileSync(join(DIR, file), `${JSON.stringify(value, null, "\t")}\n`);

/** A secret is written as the sentence it is made from, so no file holds anything that reads as a real one. */
type Secret = string | { whsecOf: string } | { base64Of: string };
const secretOf = (value: Secret): string => {
	if (typeof value === "string") return value;
	const base64 = Buffer.from("whsecOf" in value ? value.whsecOf : value.base64Of).toString("base64");
	return "whsecOf" in value ? `whsec_${base64}` : base64;
};

interface Failure {
	code: string;
	node: string;
	message?: string;
}
interface Run {
	call: string;
	input: unknown;
	output?: unknown;
	error?: Failure;
	journal?: string[];
	journalInAnyOrder?: string[];
	/** Notes that must not be in the journal: what was never started. */
	journalLacks?: string[];
	spans?: Array<Partial<Span>>;
	logged?: string[];
}
interface Sent {
	to: string;
	request: { method: string; body?: unknown; query?: unknown; params?: unknown; headers?: Record<string, string> };
	raw?: string;
	now?: number;
	status: number;
	body: unknown;
	journal?: string[];
	logged?: string[];
}
interface Case {
	name: string;
	env?: Record<string, Secret>;
	workflows?: Record<string, Workflow>;
	/** Written by this file: what the check learned about each workflow, which a kernel without a check is given. */
	built?: Record<string, { request?: JsonSchema }>;
	runs?: Run[];
	requests?: Sent[];
}
interface CaseFile {
	about: string;
	cases: Case[];
	signatures?: Array<{
		name: string;
		signature: Omit<Signature, "secret"> & { secret: Secret };
		checks: Array<{ raw: string; headers: Record<string, string | string[]>; now?: number; accepted: boolean }>;
	}>;
}

/** What crosses a boundary is JSON, so that is what is compared: a field with no value is not there. */
const json = (value: unknown): unknown => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

/** The nodes and the case's workflows, loaded the way a kernel with no check of its own loads them. */
function prepare(one: Case) {
	const units = new Map<string, Unit>(nodes.map((unit) => [unit.id, unit as Unit]));
	const env = Object.fromEntries(Object.entries(one.env ?? {}).map(([key, value]) => [key, secretOf(value)]));
	const list = Object.entries(one.workflows ?? {}).map(([name, workflow]) => ({
		id: workflowId(name, workflow),
		workflow,
	}));
	const { problems, shapes } = checkWorkflows(list, units);
	expect({ case: one.name, problems }).toEqual({ case: one.name, problems: [] });
	const built = Object.fromEntries(list.map(({ id }) => [id, { request: shapes.get(id)?.request }]));
	if (WRITE) {
		if (list.length > 0) one.built = built;
	} else {
		expect({ case: one.name, built: json(one.built ?? {}) }).toEqual({ case: one.name, built: json(built) });
	}
	const own = new Set(list.map((entry) => entry.id));
	for (const { id, workflow } of list) {
		const request = (WRITE ? built : (one.built ?? {}))[id]?.request;
		units.set(id, workflowUnit(id, workflow, units, { isWorkflow: (node) => own.has(node), env, request }));
	}
	return { units, env, workflows: new Map(list.map((entry) => [entry.id, entry.workflow])) };
}

function recorder() {
	const ports = freshPorts();
	const spans: Span[] = [];
	const logged: string[] = [];
	const log = { info() {}, error: (message: string) => void logged.push(message) };
	const { call } = runtime({ ports, log, onSpan: (span) => spans.push(span) });
	return { ports, spans, logged, log, call };
}

const spanOf = ({ id, kind, parent, key, attempts, ok, error }: Span) =>
	json({ id, kind, parent, key, attempts, ok, error });

for (const file of ["call.json", "workflow.json", "request.json", "http.json"]) {
	const content = read<CaseFile>(file);

	for (const one of content.cases) {
		test(`${file}: ${one.name}`, async () => {
			const { units, env, workflows } = prepare(one);

			for (const [index, run] of (one.runs ?? []).entries()) {
				const { ports, spans, logged, call } = recorder();
				const unit = units.get(run.call);
				if (!unit) throw new Error(`${one.name}: nothing is called "${run.call}".`);
				const got: Record<string, unknown> = {};
				const wanted: Record<string, unknown> = {};
				try {
					const output = json(await call(unit, run.input as never));
					if ("output" in run) got.output = output;
				} catch (err) {
					const known = err as BlokError;
					expect(err).toBeInstanceOf(BlokError);
					got.error = { code: known.code, node: known.node, ...(run.error?.message ? { message: known.message } : {}) };
				}
				if ("output" in run) wanted.output = run.output;
				if (run.error) wanted.error = run.error;
				if (run.journal) [got.journal, wanted.journal] = [ports.journal, run.journal];
				if (run.journalInAnyOrder) {
					[got.journalInAnyOrder, wanted.journalInAnyOrder] = [
						[...ports.journal].sort(),
						[...run.journalInAnyOrder].sort(),
					];
				}
				if (run.journalLacks) {
					[got.journalLacks, wanted.journalLacks] = [
						run.journalLacks.filter((note) => !ports.journal.includes(note)),
						run.journalLacks,
					];
				}
				if (run.spans) [got.spans, wanted.spans] = [spans.map(spanOf), run.spans];
				if (run.logged) [got.logged, wanted.logged] = [logged, run.logged];
				expect({ run: index, input: run.input, ...got }).toEqual({ run: index, input: run.input, ...wanted });
			}

			for (const [index, sent] of (one.requests ?? []).entries()) {
				const { ports, logged, log, call } = recorder();
				const unit = units.get(sent.to);
				const workflow = workflows.get(sent.to);
				if (!unit || !workflow) throw new Error(`${one.name}: there is no workflow "${sent.to}".`);
				const binding = httpBinding(workflow, unit, env) as HttpBinding;
				const request = {
					method: sent.request.method,
					body: sent.request.body ?? (sent.raw === undefined ? {} : JSON.parse(sent.raw)),
					query: sent.request.query ?? {},
					params: sent.request.params ?? {},
					headers: sent.request.headers ?? {},
				};
				const answered = await answer(binding, call, request, {
					raw: sent.raw,
					log,
					now: sent.now === undefined ? undefined : () => sent.now as number,
				});
				const got: Record<string, unknown> = { status: answered.status, body: json(answered.body) };
				const wanted: Record<string, unknown> = { status: sent.status, body: sent.body };
				if (sent.journal) [got.journal, wanted.journal] = [ports.journal, sent.journal];
				if (sent.logged) [got.logged, wanted.logged] = [logged, sent.logged];
				expect({ request: index, ...got }).toEqual({ request: index, ...wanted });
			}
		});
	}

	for (const group of content.signatures ?? []) {
		test(`${file}: ${group.name}`, async () => {
			const signature = { ...group.signature, secret: secretOf(group.signature.secret) };
			for (const [index, check] of group.checks.entries()) {
				const accepted = await signed(signature, check.raw, check.headers, check.now);
				expect({ check: index, accepted }).toEqual({ check: index, accepted: check.accepted });
				// The bytes are what is signed, however they are handed over.
				const bytes = await signed(signature, new TextEncoder().encode(check.raw), check.headers, check.now);
				expect({ check: index, bytes }).toEqual({ check: index, bytes: check.accepted });
			}
		});
	}

	if (WRITE) test(`${file}: written`, () => write(file, content));
}

// ---- schedules --------------------------------------------------------------------------

interface Times {
	schedule: string;
	zone: string;
	after: string;
	runs: string[];
}
interface ScheduleFile {
	about: string;
	next: Times[];
	unreadable: Array<{ schedule: string; problem: string }>;
	never: string[];
	notAZone: string[];
	/** Taken from croner by this file. */
	grid: Times[];
}

const GRID = {
	schedules: [
		"* * * * *",
		"*/5 * * * *",
		"0 * * * *",
		"30 4 * * *",
		"0 9-17 * * 1-5",
		"15 14 1 * *",
		"0 0 * * 0",
		"0 22 * * 1-5",
		"23 0-20/2 * * *",
		"5 4 * * sun",
		"0 0 1,15 * *",
		"0 12 * jan-mar mon",
		"59 23 31 12 *",
		"0 6 28-31 * *",
	],
	// Tokyo and São Paulo do not move their clocks. New York does, and these starts are far from the days it does.
	zones: ["UTC", "Asia/Tokyo", "America/Sao_Paulo", "America/New_York"],
	starts: ["2026-01-15T10:07:00Z", "2026-06-30T23:59:00Z", "2027-12-31T23:58:00Z", "2028-02-28T12:00:00Z"],
};

function ours({ schedule, zone, after, runs }: Times): string[] {
	const out: string[] = [];
	let at = new Date(after);
	for (let i = 0; i < runs.length; i++) {
		at = nextRun(parseSchedule(schedule), at, zone);
		out.push(at.toISOString());
	}
	return out;
}

test("schedule.json: the next run times, the schedules that cannot be read and the ones that never happen", () => {
	const content = read<ScheduleFile>("schedule.json");
	if (WRITE) {
		content.grid = GRID.schedules.flatMap((schedule) =>
			GRID.zones.flatMap((zone) =>
				GRID.starts.map((after) => ({
					schedule,
					zone,
					after,
					runs: new Cron(schedule, { timezone: zone }).nextRuns(6, new Date(after)).map((date) => date.toISOString()),
				})),
			),
		);
		write("schedule.json", content);
	}
	for (const times of [...content.next, ...content.grid]) {
		expect({ ...times, runs: ours(times) }).toEqual(times);
	}
	expect(content.grid.reduce((sum, times) => sum + times.runs.length, 0)).toBe(14 * 4 * 4 * 6);

	for (const { schedule, problem } of content.unreadable) {
		let said: string | undefined;
		try {
			parseSchedule(schedule);
		} catch (err) {
			expect(err).toBeInstanceOf(SyntaxError);
			said = (err as Error).message;
		}
		expect({ schedule, problem: said }).toEqual({ schedule, problem });
	}
	for (const schedule of content.never) {
		expect(() => nextRun(parseSchedule(schedule), new Date(0))).toThrow("it never happens");
	}
	for (const zone of content.notAZone) {
		expect(() => nextRun(parseSchedule("0 0 * * *"), new Date(0), zone)).toThrow(RangeError);
	}
});
