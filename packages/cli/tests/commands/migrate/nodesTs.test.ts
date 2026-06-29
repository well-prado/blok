import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	countStringNodeRefs,
	migrateNodesTs,
	migrateNodesTsSource,
	parseNodesMap,
	parseRuntimeStubs,
} from "../../../src/commands/migrate/nodesTs.js";

let tmpDir: string;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "blok-migrate-nodes-"));
	consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
	consoleLogSpy.mockRestore();
	await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("migrateNodesTs — handle step() node refs", () => {
	it("resolves (use,type) to module imports or distinct runtime stubs and marks unsafe refs", async () => {
		const nodesFile = await write(
			"src/Nodes.ts",
			`import ApiCall from "@blokjs/api-call";
import { HELPER_NODES } from "@blokjs/helpers";
import DupeNode from "./nodes/dupe";
import ExampleNodes from "./nodes/examples";

const thirdParty = {
	"@blokjs/api-call": ApiCall,
	dupe: DupeNode,
	...HELPER_NODES,
};

const nodes = {
	...thirdParty,
	...ExampleNodes,
};

export default nodes;
`,
		);
		await write(
			"src/nodes/examples.ts",
			`import ChatUI from "./chat-ui";

const ExampleNodes = {
	"chat-ui": ChatUI,
};

export default ExampleNodes;
`,
		);
		await write(
			"nodes-gen/runtime.go.ts",
			`import { runtimeNode } from "@blokjs/core";
export const chainTest = runtimeNode<unknown, unknown>("chain-test", "runtime.go:chain-test");
export const dupe = runtimeNode<unknown, unknown>("dupe", "runtime.go:dupe");
`,
		);
		await write(
			"nodes-gen/runtime.python3.ts",
			`import { runtimeNode } from "@blokjs/core";
export const chainTest = runtimeNode<unknown, unknown>("chain-test", "runtime.python3:chain-test");
`,
		);
		const workflow = path.join(tmpDir, "src/workflows/main.ts");
		const resolver = {
			modules: await parseNodesMap(await fsp.readFile(nodesFile, "utf8"), nodesFile),
			runtimes: await parseRuntimeStubs(path.join(tmpDir, "nodes-gen")),
		};
		const input = `import { step } from "@blokjs/core";

export function build() {
	step("fetch", "@blokjs/api-call", { url: "https://example.com" });
	step("expr", "@blokjs/expr", { expression: "1" });
	step("ui", "chat-ui", {});
	step("go", "chain-test", {}, { type: "runtime.go" });
	step("py", "chain-test", {}, { type: "runtime.python3" });
	step("dupe", "dupe", {});
	step("missing", "missing-node", {});
}
`;

		const result = migrateNodesTsSource(input, workflow, resolver);

		expect(result.stats).toEqual({ migrated: 5, marked: 2 });
		expect(result.value).toContain('import ApiCall from "@blokjs/api-call";');
		expect(result.value).toContain('import { ExprNode } from "@blokjs/helpers";');
		expect(result.value).toContain('import { chainTest } from "../../nodes-gen/runtime.go";');
		expect(result.value).toContain('import { chainTest as chainTestPython3 } from "../../nodes-gen/runtime.python3";');
		expect(result.value).toContain('import ChatUI from "../nodes/chat-ui";');
		expect(result.value).toContain('step("fetch", ApiCall');
		expect(result.value).toContain('step("expr", ExprNode');
		expect(result.value).toContain('step("ui", ChatUI');
		expect(result.value).toContain('step("go", chainTest, {}, { type: "runtime.go" })');
		expect(result.value).toContain('step("py", chainTestPython3, {}, { type: "runtime.python3" })');
		expect(result.value).toContain('// blok-migrate: hand-migrate (node resolution)\n\tstep("dupe", "dupe"');
		expect(result.value).toContain('// blok-migrate: hand-migrate (node resolution)\n\tstep("missing", "missing-node"');
		expect(migrateNodesTsSource(result.value, workflow, resolver).stats).toEqual({ migrated: 0, marked: 0 });
	});

	it("deletes Nodes.ts only after string node refs are gone", async () => {
		const nodesFile = await write("src/Nodes.ts", "export default {};\n");
		await write(
			"src/workflows/handle.ts",
			`import { step } from "@blokjs/core";
import ApiCall from "@blokjs/api-call";
export function build() { step("fetch", ApiCall, {}); }
`,
		);
		await migrateNodesTs({
			dir: path.join(tmpDir, "src/workflows"),
			nodes: nodesFile,
			stubs: path.join(tmpDir, "nodes-gen"),
			backup: false,
			deleteNodes: true,
		});
		await expect(fsp.stat(nodesFile)).rejects.toThrow();

		const keptNodesFile = await write("src/Nodes.ts", "export default {};\n");
		await write("src/workflows/object.ts", 'export default { steps: [{ id: "x", use: "still-string" }] };\n');
		expect(await countStringNodeRefs(path.join(tmpDir, "src/workflows"))).toBe(1);
		await migrateNodesTs({
			dir: path.join(tmpDir, "src/workflows"),
			nodes: keptNodesFile,
			stubs: path.join(tmpDir, "nodes-gen"),
			backup: false,
			deleteNodes: true,
		});
		await expect(fsp.stat(keptNodesFile)).resolves.toBeDefined();
	});
});

async function write(relPath: string, source: string): Promise<string> {
	const file = path.join(tmpDir, relPath);
	await fsp.mkdir(path.dirname(file), { recursive: true });
	await fsp.writeFile(file, source);
	return file;
}
