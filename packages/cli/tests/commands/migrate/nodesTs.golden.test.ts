import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateNodesTs } from "../../../src/commands/migrate/nodesTs.js";

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/migrate-nodes-ts");

let tmpDir: string;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "blok-migrate-nodes-golden-"));
	consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
	consoleLogSpy.mockRestore();
	await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("migrateNodesTs — golden fixtures", () => {
	it("keeps five same-name runtime stubs distinct", async () => {
		const actual = await runFixture("five-runtime-chain", "src/workflows/cross-runtime-chain.ts");

		expect(actual.match(/from "\.\.\/\.\.\/nodes-gen\/runtime\./g)).toHaveLength(5);
		expect(actual).toContain('step("go", chainTest, {}, { type: "runtime.go" })');
		expect(actual).toContain('step("rust", chainTestRust, {}, { type: "runtime.rust" })');
		expect(actual).toContain('step("java", chainTestJava, {}, { type: "runtime.java" })');
		expect(actual).toContain('step("csharp", chainTestCsharp, {}, { type: "runtime.csharp" })');
		expect(actual).toContain('step("python", chainTestPython3, {}, { type: "runtime.python3" })');
	});

	it("resolves HELPER_NODES members and marks unsafe refs", async () => {
		const actual = await runFixture("helper-spread-markers", "src/workflows/helper-spread.ts");

		expect(actual).toContain('import { ExprNode, LogNode, ThrowNode } from "@blokjs/helpers";');
		expect(actual).not.toContain("HELPER_NODES");
		expect(actual).toContain('step("expr", ExprNode');
		expect(actual).toContain('step("log", LogNode');
		expect(actual).toContain('step("throw", ThrowNode');
		expect(actual.match(/blok-migrate: hand-migrate \(node resolution\)/g)).toHaveLength(2);
		expect(actual).toContain('step("dupe", "dupe"');
		expect(actual).toContain('step("missing", "missing-node"');
	});
});

async function runFixture(name: string, workflowRel: string): Promise<string> {
	const root = path.join(tmpDir, name);
	await fsp.cp(path.join(fixtureRoot, name, "input"), root, { recursive: true });
	await migrateNodesTs({
		dir: path.join(root, "src/workflows"),
		nodes: path.join(root, "src/Nodes.ts"),
		stubs: path.join(root, "nodes-gen"),
		backup: false,
	});

	const actual = await fsp.readFile(path.join(root, workflowRel), "utf8");
	const expected = await fsp.readFile(path.join(fixtureRoot, name, "expected", `${workflowRel}.txt`), "utf8");
	expect(actual).toBe(expected);
	return actual;
}
