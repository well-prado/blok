/**
 * Guards the AGENTS.md workflow examples after their migration to the
 * `@blokjs/core` typed-handle DSL. The examples live inside the `agents_md`
 * template literal (shipped verbatim as AGENTS.md), so a broken example would
 * pass `tsc` on the outer file yet be invalid DSL. This test EXTRACTS each
 * migrated ` ```ts ` fence, writes it inside the package (so `@blokjs/core`
 * resolves via the workspace), imports it, resolves the async builder (full Zod
 * validation), and loads it through the real engine. The node-backed ones also
 * execute with all nodes auto-mocked.
 *
 * Run inside the package (`vitest run --root packages/cli`) so `@blokjs/runner`
 * resolves to the LOCAL build (the real WorkflowTestRunner), not a cached publish.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WorkflowTestRunner } from "@blokjs/runner/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents_md } from "../src/commands/create/utils/Examples";

const tmpDir = path.join(__dirname, "__tmp_examples");
const FENCE = "```";

/** Slice the fenced code block that contains `export default workflow("<name>"`. */
function extractExample(name: string): string {
	const marker = `export default workflow("${name}"`;
	const at = agents_md.indexOf(marker);
	if (at < 0) throw new Error(`example fence not found for "${name}"`);
	const open = agents_md.lastIndexOf(FENCE, at);
	const codeStart = agents_md.indexOf("\n", open) + 1;
	const close = agents_md.indexOf(FENCE, at);
	return `${agents_md.slice(codeStart, close).replace(/\s+$/, "")}\n`;
}

// The migrated per-trigger canonical examples + the middleware definition. The
// name is the unique `workflow("<name>", ...)` first arg.
const EXECUTABLE = [
	"Get User", // http
	"Process Background Job", // worker
	"Daily Cleanup", // cron
	"On Order Placed", // pubsub (+ idempotencyKey)
	"Clock Stream", // sse
	"WS Echo", // websocket (+ js`` escape hatch)
	"search_code", // mcp (+ input: z.object)
	"GetUser", // grpc
	"auth-check", // middleware: true (no trigger)
];
// Polymorphic sub-workflow dispatch — the child workflow isn't registered here,
// so validate the DSL by loading it; executing would need a WorkflowRegistry.
const LOAD_ONLY = ["Stripe Webhook"];

describe("AGENTS.md workflow examples — @blokjs/core typed-handle DSL", () => {
	beforeAll(() => mkdirSync(tmpDir, { recursive: true }));
	afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

	for (const name of [...EXECUTABLE, ...LOAD_ONLY]) {
		it(`"${name}" is valid typed-handle DSL that loads through the engine`, async () => {
			const code = extractExample(name);

			// The migrated body is typed-handle, not legacy object-style.
			expect(code).toContain('from "@blokjs/core"');
			expect(code).not.toContain("@blokjs/helper");
			expect(code).not.toContain("$.state");

			const slug = name.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();
			const file = path.join(tmpDir, `${slug}.ts`);
			writeFileSync(file, code);

			const mod = await import(file);
			const wf = await mod.default; // resolves the async builder → full Zod validation
			const runner = new WorkflowTestRunner({ mockAllNodes: true });
			runner.loadWorkflow(wf); // must be accepted as a valid v2 workflow model

			if (EXECUTABLE.includes(name)) {
				const result = await runner.execute({});
				expect(result.success).toBe(true);
			}
		});
	}
});
