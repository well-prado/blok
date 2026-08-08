import { describe, expect, it } from "vitest";
import {
	generateCronExampleWorkflowFile,
	generateCronServerFile,
	generateSharedWorkflowsFile,
	generateTriggerEntryFile,
} from "../../../src/commands/create/project.js";

/**
 * Regression (#642): `blokctl dev` for a cron scaffold used to fall through to
 * the generic `generateTriggerEntryFile` fallback that emits
 * `console.log("cron trigger not yet implemented")` — so a scaffolded cron
 * trigger never scheduled anything. The scaffold now generates a real entry +
 * a CronServer wrapper (a thin CronTrigger subclass, like WorkerServer).
 */
describe("cron trigger scaffold (#642)", () => {
	it("generateTriggerEntryFile('cron') emits a real entry, not the not-implemented stub", () => {
		const out = generateTriggerEntryFile("cron");
		expect(out).not.toContain("not yet implemented");
		expect(out).toContain('import CronServer from "./runner/CronServer.js"');
		expect(out).toContain("new CronServer()");
		expect(out).toContain("this.cronServer.listen()");
		// #733 — cron used to boot on plain import (bare env-var guard); it now
		// carries the same realpath'd argv[1] isMainModule() guard #732 added to
		// the http/sse/grpc branches, so importing this file for introspection
		// (e.g. the source-import gate) performs no I/O.
		expect(out).toContain('if (isMainModule(import.meta.url) && process.env.DISABLE_TRIGGER_RUN !== "true")');
	});

	it("other unimplemented kinds still hit the fallback (guards against a broad edit)", () => {
		expect(generateTriggerEntryFile("madeuptrigger")).toContain("not yet implemented");
	});

	// #733 — the pubsub/queue branches inside generateTriggerEntryFile were dead
	// code: `createProject`'s `triggersWithRealTemplate` set always routes those
	// two kinds through the real `template/src/index.ts` copy and `continue`s
	// past the `generateTriggerEntryFile(triggerKind, ...)` call for them (see
	// the loop in project.ts, right after `generateSharedWorkflowsFile`). Deleted
	// rather than guarded; these two now fall through to the same generic
	// "not yet implemented" stub as any other unhandled kind, proving nothing
	// still branches on them internally.
	it("generateTriggerEntryFile('pubsub'|'queue') hit the generic fallback — their dedicated branches are gone", () => {
		expect(generateTriggerEntryFile("pubsub")).toContain("pubsub trigger not yet implemented");
		expect(generateTriggerEntryFile("queue")).toContain("queue trigger not yet implemented");
	});

	it("generateCronServerFile() is a declarative CronTrigger subclass with nodes + workflows", () => {
		const out = generateCronServerFile();
		expect(out).toContain('import { CronTrigger } from "@blokjs/trigger-cron"');
		expect(out).toContain('import nodes from "../../../Nodes.js"');
		expect(out).toContain('import workflows from "../../../Workflows.js"');
		expect(out).toContain("export default class CronServer extends CronTrigger");
		expect(out).toContain("protected nodes");
		expect(out).toContain("protected workflows");
	});

	it("ships a runnable cron workflow so the trigger isn't idle out of the box", () => {
		const wf = generateCronExampleWorkflowFile();
		expect(wf).toContain("trigger: { cron: {");
		expect(wf).toContain('node("@blokjs/expr")');

		// generateSharedWorkflowsFile registers it (cron reads Workflows.ts, not
		// the HTTP JSON auto-scan).
		const registry = generateSharedWorkflowsFile(["cron"]);
		expect(registry).toContain('import CronHeartbeat from "./workflows/cron/heartbeat.js"');
		expect(registry).toContain('"cron-heartbeat": await CronHeartbeat');
	});
});
