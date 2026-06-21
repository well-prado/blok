/**
 * F23 (Bug 01 part C) — the missing-middleware error hint must cover ALL
 * registration paths, not just a scanned `WORKFLOWS_PATH` directory.
 *
 * Pre-fix the hint pinned the author to one mechanism (JSON directory
 * scan), so the most common real causes — a typo in a
 * `BLOK_GLOBAL_MIDDLEWARE` / `setGlobalMiddleware()` /
 * `trigger.<kind>.middleware` name, or a name mismatch — were never
 * mentioned, and TS `src/Workflows.ts` + worker/cron nodeMap
 * registration were invisible.
 */

import type { Context } from "@blokjs/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import TriggerBase from "../../src/TriggerBase";
import type GlobalOptions from "../../src/types/GlobalOptions";
import { WorkflowRegistry } from "../../src/workflow/WorkflowRegistry";

class TestTrigger extends TriggerBase {
	override async listen(): Promise<number> {
		return 0;
	}

	async stop(): Promise<void> {
		// no-op
	}

	// Expose the protected dispatcher so we can assert its error directly.
	async dispatch(ctx: Context, names: string[], nodeMap: GlobalOptions): Promise<void> {
		await this.runMiddlewareChain(ctx, names, nodeMap);
	}
}

const stubCtx = (): Context =>
	({
		id: "t",
		workflow_name: "wf",
		request: { headers: {}, body: {}, query: {}, params: {} },
		response: { data: null, contentType: "application/json", success: true, error: null },
		error: { message: [] },
		logger: { log: () => {}, error: () => {} },
		config: {},
		vars: {},
		env: {},
	}) as unknown as Context;

const stubNodeMap = (): GlobalOptions => ({}) as unknown as GlobalOptions;

describe("TriggerBase.runMiddlewareChain — F23 missing-middleware hint", () => {
	beforeEach(() => WorkflowRegistry.resetInstance());
	afterEach(() => WorkflowRegistry.resetInstance());

	it("error names the unknown middleware + the exact-name requirement", async () => {
		const t = new TestTrigger();
		let message = "";
		try {
			await t.dispatch(stubCtx(), ["request-id"], stubNodeMap());
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toMatch(/middleware "request-id" not found/);
		expect(message).toMatch(/exactly matches a registered workflow's `name`/);
	});

	it("hint mentions all registration sources (env / programmatic / trigger-level / TS Workflows.ts / nodeMap)", async () => {
		const t = new TestTrigger();
		let message = "";
		try {
			await t.dispatch(stubCtx(), ["typo-mw"], stubNodeMap());
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toMatch(/BLOK_GLOBAL_MIDDLEWARE/);
		expect(message).toMatch(/setGlobalMiddleware\(\)/);
		expect(message).toMatch(/trigger\.<kind>\.middleware/);
		expect(message).toMatch(/src\/Workflows\.ts/);
		expect(message).toMatch(/worker\/cron nodeMap registration/);
		// And it still tells them about the `middleware: true` marker.
		expect(message).toMatch(/"middleware": true/);
	});

	it("lists registered middleware names so an operator can diff for a mismatch", async () => {
		const registry = WorkflowRegistry.getInstance();
		registry.register({ name: "audit-log", source: "<inline>", workflow: {}, isMiddleware: true });
		const t = new TestTrigger();
		let message = "";
		try {
			await t.dispatch(stubCtx(), ["audit-logg"], stubNodeMap());
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toMatch(/Available middleware: audit-log/);
	});
});
