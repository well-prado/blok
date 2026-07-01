/**
 * Guards the `create workflow` scaffold output after its migration to a TS
 * typed-handle workflow. Interpolates the real `workflow_template` the way the
 * command does, writes it inside the package (so its `import "@blokjs/core"`
 * resolves via the workspace), imports it, and runs it through the real engine.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WorkflowTestRunner } from "@blokjs/runner/testing";
import { afterAll, describe, expect, it } from "vitest";
import { workflow_template } from "../src/commands/create/utils/Examples";

const scaffoldDir = path.join(__dirname, "__tmp_scaffold");

describe("create workflow — TS typed-handle scaffold output", () => {
	afterAll(() => rmSync(scaffoldDir, { recursive: true, force: true }));

	it("interpolates workflow_template into a valid workflow that runs through the engine", async () => {
		const name = "My Test Workflow";
		const slug = name.replaceAll(" ", "-").toLowerCase();
		const content = workflow_template.replaceAll("{{WORKFLOW_NAME}}", name).replaceAll("{{WORKFLOW_PATH}}", `/${slug}`);

		// No leftover placeholders; it is the typed-handle DSL.
		expect(content).not.toContain("{{");
		expect(content).toContain('from "@blokjs/core"');
		expect(content).toContain('"My Test Workflow"');
		expect(content).toContain('http.get("/my-test-workflow")');

		mkdirSync(scaffoldDir, { recursive: true });
		const file = path.join(scaffoldDir, `${slug}.ts`);
		writeFileSync(file, content);

		const mod = await import(file);
		const wf = await mod.default;
		const runner = new WorkflowTestRunner();
		let received: unknown;
		runner.mockNode("@blokjs/respond", async (input) => {
			received = input;
			return input;
		});
		runner.loadWorkflow(wf);

		const result = await runner.execute({ hello: "world" });
		expect(result.success).toBe(true);
		// The echo step ran with req.body resolved (respond is ephemeral → no state slot).
		expect(received).toEqual({ body: { hello: "world" } });
	});
});
