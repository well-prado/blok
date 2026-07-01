import { describe, expect, it } from "vitest";
import {
	generateCronExampleWorkflowFile,
	generateCronServerFile,
	generateSharedWorkflowsFile,
	generateTriggerEntryFile,
} from "../../../src/commands/create/project";

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
		expect(out).toContain('import CronServer from "./runner/CronServer"');
		expect(out).toContain("new CronServer()");
		expect(out).toContain("this.cronServer.listen()");
		expect(out).toContain('if (process.env.DISABLE_TRIGGER_RUN !== "true")');
	});

	it("other unimplemented kinds still hit the fallback (guards against a broad edit)", () => {
		expect(generateTriggerEntryFile("madeuptrigger")).toContain("not yet implemented");
	});

	it("generateCronServerFile() is a declarative CronTrigger subclass with nodes + workflows", () => {
		const out = generateCronServerFile();
		expect(out).toContain('import { CronTrigger } from "@blokjs/trigger-cron"');
		expect(out).toContain('import nodes from "../../../Nodes"');
		expect(out).toContain('import workflows from "../../../Workflows"');
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
		expect(registry).toContain('import CronHeartbeat from "./workflows/cron/heartbeat"');
		expect(registry).toContain('"cron-heartbeat": await CronHeartbeat');
	});
});
