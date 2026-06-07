import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type WorkflowEntry,
	buildAppTypeSource,
	extractWorkflowName,
	generateAppTypes,
	importSpecifier,
	nameToIdentifier,
} from "./appTypes.js";

describe("extractWorkflowName", () => {
	it("extracts the name from a v2 workflow() factory call", () => {
		const src = `import { workflow } from "@blokjs/helper";
export default workflow({ name: "users.list", version: "1.0.0", trigger: { http: { method: "GET" } }, steps: [{ id: "s", use: "@blokjs/respond", inputs: {} }] });`;
		expect(extractWorkflowName(src)).toBe("users.list");
	});

	it("handles the legacy Workflow() factory and single quotes", () => {
		expect(extractWorkflowName("const x = Workflow({ name: 'orders.create' })")).toBe("orders.create");
	});

	it("anchors on the factory call, not a step/node `name:`", () => {
		const src = `export default workflow({
			name: "the.workflow",
			steps: [{ id: "x", use: "n", inputs: { name: "not-the-workflow" } }],
		});`;
		expect(extractWorkflowName(src)).toBe("the.workflow");
	});

	it("ignores a commented-out name", () => {
		const src = `// name: "commented"
		/* name: "blocked" */
		export default workflow({ name: "real.name" });`;
		expect(extractWorkflowName(src)).toBe("real.name");
	});

	it("returns null when there is no workflow factory call", () => {
		expect(extractWorkflowName(`export const x = { name: "not.a.workflow" };`)).toBeNull();
	});

	it("returns null when the name is a non-literal (variable)", () => {
		expect(extractWorkflowName(`export default workflow({ name: WF_NAME, version: "1" })`)).toBeNull();
	});
});

describe("nameToIdentifier", () => {
	it("camelCases a dotted name", () => {
		expect(nameToIdentifier("users.list")).toBe("usersList");
		expect(nameToIdentifier("a.b.c")).toBe("aBC");
	});
	it("passes a single segment through", () => {
		expect(nameToIdentifier("health")).toBe("health");
	});
	it("prefixes identifiers that would start with a digit", () => {
		expect(nameToIdentifier("2fa.verify")).toBe("wf_2faVerify");
	});
});

describe("importSpecifier", () => {
	it("computes a relative, extensionless, ./-prefixed specifier", () => {
		const spec = importSpecifier("/proj/blok-app.d.ts", "/proj/triggers/http/src/workflows/users/list.ts");
		expect(spec).toBe("./triggers/http/src/workflows/users/list");
	});
	it("emits ../ when the workflow is above the output dir", () => {
		const spec = importSpecifier("/proj/web/blok-app.d.ts", "/proj/server/workflows/health.ts");
		expect(spec).toBe("../server/workflows/health");
	});
});

describe("buildAppTypeSource", () => {
	const out = "/proj/blok-app.d.ts";

	it("nests workflows by their dotted name and imports each by file", () => {
		const entries: WorkflowEntry[] = [
			{ name: "users.list", file: "/proj/wf/users/list.ts" },
			{ name: "users.create", file: "/proj/wf/users/create.ts" },
			{ name: "health", file: "/proj/wf/health.ts" },
		];
		const { source, collisions } = buildAppTypeSource(entries, out);
		expect(collisions).toEqual([]);
		expect(source).toContain('import type usersList from "./wf/users/list";');
		expect(source).toContain('import type usersCreate from "./wf/users/create";');
		expect(source).toContain('import type health from "./wf/health";');
		expect(source).toContain("export type BlokApp = {");
		expect(source).toContain("users: {");
		expect(source).toContain("list: usersList;");
		expect(source).toContain("create: usersCreate;");
		expect(source).toContain("health: health;");
	});

	it("flags a leaf-vs-group collision and drops the loser", () => {
		const entries: WorkflowEntry[] = [
			{ name: "users", file: "/proj/wf/users.ts" },
			{ name: "users.list", file: "/proj/wf/users/list.ts" },
		];
		const { collisions } = buildAppTypeSource(entries, out);
		expect(collisions.length).toBe(1);
	});

	it("quotes non-identifier path segments", () => {
		const { source } = buildAppTypeSource([{ name: "weird-name.go", file: "/proj/wf/x.ts" }], out);
		expect(source).toContain('"weird-name":');
	});

	it("emits an empty-but-valid type when there are no workflows", () => {
		const { source } = buildAppTypeSource([], out);
		expect(source).toContain("export type BlokApp = Record<string, never>;");
	});
});

describe("generateAppTypes (fs integration)", () => {
	const tmpDirs: string[] = [];
	afterEach(async () => {
		for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
		tmpDirs.length = 0;
	});

	it("scans a workflows dir and writes blok-app.d.ts", async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "blok-gen-"));
		tmpDirs.push(root);
		const wfDir = path.join(root, "workflows", "users");
		await fsp.mkdir(wfDir, { recursive: true });
		await fsp.writeFile(
			path.join(wfDir, "list.ts"),
			`import { workflow } from "@blokjs/helper";
export default workflow({ name: "users.list", version: "1.0.0", trigger: { http: { method: "GET" } }, steps: [] });`,
		);
		// A non-workflow TS file → skipped silently.
		await fsp.writeFile(path.join(root, "workflows", "_helper.ts"), "export const x = 1;");

		const out = path.join(root, "blok-app.d.ts");
		await generateAppTypes({ dir: path.join(root, "workflows"), out });

		const written = await fsp.readFile(out, "utf8");
		expect(written).toContain("export type BlokApp = {");
		expect(written).toContain("users: {");
		expect(written).toContain("list: usersList;");
		expect(written).toContain('import type usersList from "./workflows/users/list";');
	});
});
