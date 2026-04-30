import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateWorkflows } from "../../../src/commands/migrate/workflows.js";

let tmpDir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
	tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "blok-migrate-"));
	cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
	exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
	consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
	cwdSpy.mockRestore();
	exitSpy.mockRestore();
	consoleLogSpy.mockRestore();
	await fsp.rm(tmpDir, { recursive: true, force: true });
});

async function writeWorkflow(filename: string, content: object): Promise<void> {
	const dir = path.join(tmpDir, "workflows", "json");
	await fsp.mkdir(dir, { recursive: true });
	await fsp.writeFile(path.join(dir, filename), JSON.stringify(content, null, "\t"));
}

async function readWorkflow(filename: string): Promise<Record<string, unknown>> {
	const filepath = path.join(tmpDir, "workflows", "json", filename);
	const text = await fsp.readFile(filepath, "utf8");
	return JSON.parse(text);
}

describe("migrateWorkflows — v1 step shape conversion", () => {
	it("rewrites name → id and node → use", async () => {
		await writeWorkflow("simple.json", {
			name: "Simple",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/" } },
			steps: [{ name: "fetch", node: "@blokjs/api-call", type: "module" }],
			nodes: { fetch: { inputs: { url: "https://example.com" } } },
		});

		await migrateWorkflows({ stripLegacyPath: true, backup: false });

		const out = await readWorkflow("simple.json");
		const steps = out.steps as Array<Record<string, unknown>>;
		expect(steps).toHaveLength(1);
		expect(steps[0].id).toBe("fetch");
		expect(steps[0].use).toBe("@blokjs/api-call");
		expect(steps[0].name).toBeUndefined();
		expect(steps[0].node).toBeUndefined();
	});

	it("inlines nodes[name].inputs onto the step", async () => {
		await writeWorkflow("simple.json", {
			name: "Simple",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/" } },
			steps: [{ name: "fetch", node: "@blokjs/api-call", type: "module" }],
			nodes: { fetch: { inputs: { url: "https://example.com", method: "GET" } } },
		});

		await migrateWorkflows({ stripLegacyPath: true, backup: false });

		const out = await readWorkflow("simple.json");
		const step = (out.steps as Array<Record<string, unknown>>)[0];
		expect(step.inputs).toEqual({ url: "https://example.com", method: "GET" });
		expect(out.nodes).toBeUndefined();
	});

	it("drops set_var: true (now default)", async () => {
		await writeWorkflow("simple.json", {
			name: "Simple",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/" } },
			steps: [{ name: "fetch", node: "@blokjs/api-call", type: "module", set_var: true }],
			nodes: { fetch: { inputs: {} } },
		});

		await migrateWorkflows({ stripLegacyPath: true, backup: false });

		const step = (await readWorkflow("simple.json")).steps as Array<Record<string, unknown>>;
		expect(step[0].set_var).toBeUndefined();
	});

	it("converts set_var: false → ephemeral: true", async () => {
		await writeWorkflow("simple.json", {
			name: "Simple",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/" } },
			steps: [{ name: "log", node: "@blokjs/api-call", type: "module", set_var: false }],
			nodes: { log: { inputs: {} } },
		});

		await migrateWorkflows({ stripLegacyPath: true, backup: false });

		const step = (await readWorkflow("simple.json")).steps as Array<Record<string, unknown>>;
		expect(step[0].ephemeral).toBe(true);
		expect(step[0].set_var).toBeUndefined();
	});

	it("preserves active and stop flags", async () => {
		await writeWorkflow("simple.json", {
			name: "Simple",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/" } },
			steps: [
				{ name: "skipped", node: "@blokjs/api-call", type: "module", active: false },
				{ name: "halts", node: "@blokjs/api-call", type: "module", stop: true },
			],
			nodes: { skipped: { inputs: {} }, halts: { inputs: {} } },
		});

		await migrateWorkflows({ stripLegacyPath: true, backup: false });

		const steps = (await readWorkflow("simple.json")).steps as Array<Record<string, unknown>>;
		expect(steps[0].active).toBe(false);
		expect(steps[1].stop).toBe(true);
	});
});

describe("migrateWorkflows — branch (if-else) conversion", () => {
	it("converts nodes[].conditions if/else into a branch step", async () => {
		await writeWorkflow("router.json", {
			name: "Router",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/" } },
			steps: [{ name: "filter-request", node: "@blokjs/if-else", type: "module" }],
			nodes: {
				"filter-request": {
					conditions: [
						{
							type: "if",
							condition: 'ctx.request.query.kind === "a"',
							steps: [{ name: "branch-a", node: "@blokjs/api-call", type: "module" }],
						},
						{
							type: "else",
							steps: [{ name: "branch-b", node: "@blokjs/api-call", type: "module" }],
						},
					],
				},
			},
		});

		await migrateWorkflows({ stripLegacyPath: true, backup: false });

		const out = await readWorkflow("router.json");
		const steps = out.steps as Array<Record<string, unknown>>;
		expect(steps).toHaveLength(1);

		const branchStep = steps[0];
		expect(branchStep.id).toBe("filter-request");
		const branch = branchStep.branch as Record<string, unknown>;
		expect(branch.when).toBe('ctx.request.query.kind === "a"');

		const thenSteps = branch.then as Array<Record<string, unknown>>;
		expect(thenSteps).toHaveLength(1);
		expect(thenSteps[0].id).toBe("branch-a");
		expect(thenSteps[0].use).toBe("@blokjs/api-call");

		const elseSteps = branch.else as Array<Record<string, unknown>>;
		expect(elseSteps).toHaveLength(1);
		expect(elseSteps[0].id).toBe("branch-b");
	});

	it("omits else when only an if branch exists", async () => {
		await writeWorkflow("router.json", {
			name: "Router",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/" } },
			steps: [{ name: "gate", node: "@blokjs/if-else", type: "module" }],
			nodes: {
				gate: {
					conditions: [
						{
							type: "if",
							condition: "true",
							steps: [{ name: "go", node: "@blokjs/api-call", type: "module" }],
						},
					],
				},
			},
		});

		await migrateWorkflows({ stripLegacyPath: true, backup: false });

		const branch = ((await readWorkflow("router.json")).steps as Array<Record<string, unknown>>)[0].branch as Record<
			string,
			unknown
		>;
		expect(branch.else).toBeUndefined();
	});
});

describe("migrateWorkflows — trigger handling", () => {
	it("converts method '*' to 'ANY'", async () => {
		await writeWorkflow("wildcard.json", {
			name: "Wildcard",
			version: "1.0.0",
			trigger: { http: { method: "*", path: "/" } },
			steps: [{ name: "step", node: "@blokjs/api-call", type: "module" }],
			nodes: { step: { inputs: {} } },
		});

		await migrateWorkflows({ stripLegacyPath: true, backup: false });

		const trigger = (await readWorkflow("wildcard.json")).trigger as Record<string, Record<string, unknown>>;
		expect(trigger.http.method).toBe("ANY");
	});

	it("preserves the legacy URL by injecting trigger.http.path = /<filename-key>", async () => {
		await writeWorkflow("countries.json", {
			name: "Countries",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/" } },
			steps: [{ name: "fetch", node: "@blokjs/api-call", type: "module" }],
			nodes: { fetch: { inputs: { url: "https://example.com" } } },
		});

		await migrateWorkflows({ backup: false });

		const trigger = (await readWorkflow("countries.json")).trigger as Record<string, Record<string, unknown>>;
		expect(trigger.http.path).toBe("/countries");
	});

	it("appends a non-/ existing path to the legacy URL", async () => {
		await writeWorkflow("countries.json", {
			name: "Countries",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/:id" } },
			steps: [{ name: "fetch", node: "@blokjs/api-call", type: "module" }],
			nodes: { fetch: { inputs: {} } },
		});

		await migrateWorkflows({ backup: false });

		const trigger = (await readWorkflow("countries.json")).trigger as Record<string, Record<string, unknown>>;
		expect(trigger.http.path).toBe("/countries/:id");
	});

	it("does not preserve URL when --strip-legacy-path is set", async () => {
		await writeWorkflow("countries.json", {
			name: "Countries",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/" } },
			steps: [{ name: "fetch", node: "@blokjs/api-call", type: "module" }],
			nodes: { fetch: { inputs: {} } },
		});

		await migrateWorkflows({ stripLegacyPath: true, backup: false });

		const trigger = (await readWorkflow("countries.json")).trigger as Record<string, Record<string, unknown>>;
		expect(trigger.http.path).toBe("/");
	});
});

describe("migrateWorkflows — flags", () => {
	it("--dry-run leaves files untouched", async () => {
		await writeWorkflow("simple.json", {
			name: "Simple",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/" } },
			steps: [{ name: "fetch", node: "@blokjs/api-call", type: "module" }],
			nodes: { fetch: { inputs: { url: "https://example.com" } } },
		});

		const before = await fsp.readFile(path.join(tmpDir, "workflows", "json", "simple.json"), "utf8");

		await migrateWorkflows({ dryRun: true });

		const after = await fsp.readFile(path.join(tmpDir, "workflows", "json", "simple.json"), "utf8");
		expect(after).toBe(before);
	});

	it("creates .bak file by default", async () => {
		await writeWorkflow("simple.json", {
			name: "Simple",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/" } },
			steps: [{ name: "fetch", node: "@blokjs/api-call", type: "module" }],
			nodes: { fetch: { inputs: {} } },
		});

		await migrateWorkflows({ stripLegacyPath: true });

		const bakExists = await fsp
			.stat(path.join(tmpDir, "workflows", "json", "simple.json.bak"))
			.then(() => true)
			.catch(() => false);
		expect(bakExists).toBe(true);
	});

	it("skips .bak when --no-backup", async () => {
		await writeWorkflow("simple.json", {
			name: "Simple",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/" } },
			steps: [{ name: "fetch", node: "@blokjs/api-call", type: "module" }],
			nodes: { fetch: { inputs: {} } },
		});

		await migrateWorkflows({ stripLegacyPath: true, backup: false });

		const bakExists = await fsp
			.stat(path.join(tmpDir, "workflows", "json", "simple.json.bak"))
			.then(() => true)
			.catch(() => false);
		expect(bakExists).toBe(false);
	});
});

describe("migrateWorkflows — already-v2 detection", () => {
	it("leaves v2 files untouched when no legacy refs exist", async () => {
		const v2Workflow = {
			name: "Already V2",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/already-v2" } },
			steps: [{ id: "fetch", use: "@blokjs/api-call", inputs: { url: "https://x.com" } }],
		};
		// Write with a trailing newline so it matches the migrator's canonical output verbatim.
		const dir = path.join(tmpDir, "workflows", "json");
		await fsp.mkdir(dir, { recursive: true });
		await fsp.writeFile(path.join(dir, "already-v2.json"), `${JSON.stringify(v2Workflow, null, "\t")}\n`);
		const before = await fsp.readFile(path.join(dir, "already-v2.json"), "utf8");

		await migrateWorkflows({ backup: false });

		const after = await fsp.readFile(path.join(dir, "already-v2.json"), "utf8");
		expect(after).toBe(before);
	});
});

describe("migrateWorkflows — legacy js/ expression rewrite", () => {
	it("rewrites js/ctx.vars[...] → js/ctx.state[...] inside inputs", async () => {
		await writeWorkflow("chain.json", {
			name: "Chain",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/chain" } },
			steps: [
				{ id: "init", use: "init-node", inputs: {} },
				{
					id: "next",
					use: "next-node",
					inputs: {
						chain: "js/ctx.vars['init'].chain",
						origin: "js/ctx.vars['init'].origin",
					},
				},
			],
		});

		await migrateWorkflows({ backup: false });

		const out = await readWorkflow("chain.json");
		const next = (out.steps as Array<Record<string, unknown>>)[1];
		const inputs = next.inputs as Record<string, string>;
		expect(inputs.chain).toBe("js/ctx.state['init'].chain");
		expect(inputs.origin).toBe("js/ctx.state['init'].origin");
	});

	it("rewrites js/ctx.response.data → js/ctx.prev.data", async () => {
		await writeWorkflow("respdata.json", {
			name: "RespData",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/respdata" } },
			steps: [{ id: "step", use: "node", inputs: { body: "js/ctx.response.data.user" } }],
		});

		await migrateWorkflows({ backup: false });

		const out = await readWorkflow("respdata.json");
		const inputs = (out.steps as Array<Record<string, unknown>>)[0].inputs as Record<string, string>;
		expect(inputs.body).toBe("js/ctx.prev.data.user");
	});

	it("rewrites ${ctx.vars[...]} template strings", async () => {
		await writeWorkflow("template.json", {
			name: "Template",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/template" } },
			steps: [{ id: "step", use: "node", inputs: { greeting: "Hello ${ctx.vars['name']}!" } }],
		});

		await migrateWorkflows({ backup: false });

		const out = await readWorkflow("template.json");
		const inputs = (out.steps as Array<Record<string, unknown>>)[0].inputs as Record<string, string>;
		expect(inputs.greeting).toBe("Hello ${ctx.state['name']}!");
	});

	it("rewrites refs nested inside arrays and sub-objects", async () => {
		await writeWorkflow("nested.json", {
			name: "Nested",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/nested" } },
			steps: [
				{
					id: "step",
					use: "node",
					inputs: {
						messages: ["static", "js/ctx.vars['data']", { deep: { ref: "js/ctx.vars['x'].y" } }],
					},
				},
			],
		});

		await migrateWorkflows({ backup: false });

		const out = await readWorkflow("nested.json");
		const inputs = (out.steps as Array<Record<string, unknown>>)[0].inputs as { messages: unknown[] };
		expect(inputs.messages[1]).toBe("js/ctx.state['data']");
		expect((inputs.messages[2] as { deep: { ref: string } }).deep.ref).toBe("js/ctx.state['x'].y");
	});

	it("rewrites refs inside a v2 branch step's nested inputs and when", async () => {
		await writeWorkflow("branch.json", {
			name: "Branch",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/branch" } },
			steps: [
				{
					id: "router",
					branch: {
						when: "ctx.vars['choice'] === 'a'",
						then: [{ id: "a", use: "n", inputs: { val: "js/ctx.vars['init'].x" } }],
						else: [{ id: "b", use: "n", inputs: { val: "js/ctx.response.data" } }],
					},
				},
			],
		});

		await migrateWorkflows({ backup: false });

		const out = await readWorkflow("branch.json");
		const router = (out.steps as Array<Record<string, unknown>>)[0];
		const branch = router.branch as Record<string, unknown>;
		// Bare `ctx.vars[...]` (no js/ or ${ prefix) is NOT rewritten by
		// design — the runtime resolves either form via the alias and
		// rewriting unprefixed JS identifiers risks collateral damage.
		expect(branch.when).toBe("ctx.vars['choice'] === 'a'");

		const thenSteps = branch.then as Array<Record<string, unknown>>;
		expect((thenSteps[0].inputs as { val: string }).val).toBe("js/ctx.state['init'].x");

		const elseSteps = branch.else as Array<Record<string, unknown>>;
		expect((elseSteps[0].inputs as { val: string }).val).toBe("js/ctx.prev.data");
	});

	it("does not touch non-legacy js/ expressions", async () => {
		await writeWorkflow("safe.json", {
			name: "Safe",
			version: "1.0.0",
			trigger: { http: { method: "POST", path: "/safe" } },
			steps: [
				{
					id: "step",
					use: "node",
					inputs: {
						varsKey: "js/ctx.varsKey",
						unrelated: "js/ctx.req.body",
						already: "js/ctx.state.foo",
					},
				},
			],
		});

		await migrateWorkflows({ backup: false });

		const out = await readWorkflow("safe.json");
		const inputs = (out.steps as Array<Record<string, unknown>>)[0].inputs as Record<string, string>;
		expect(inputs.varsKey).toBe("js/ctx.varsKey");
		expect(inputs.unrelated).toBe("js/ctx.req.body");
		expect(inputs.already).toBe("js/ctx.state.foo");
	});
});

describe("migrateWorkflows — recursive scan", () => {
	it("walks subfolders", async () => {
		const usersDir = path.join(tmpDir, "workflows", "json", "users");
		await fsp.mkdir(usersDir, { recursive: true });
		await fsp.writeFile(
			path.join(usersDir, "list.json"),
			JSON.stringify({
				name: "List",
				version: "1.0.0",
				trigger: { http: { method: "GET", path: "/" } },
				steps: [{ name: "fetch", node: "@blokjs/api-call", type: "module" }],
				nodes: { fetch: { inputs: {} } },
			}),
		);

		await migrateWorkflows({ stripLegacyPath: true, backup: false });

		const out = JSON.parse(await fsp.readFile(path.join(usersDir, "list.json"), "utf8"));
		expect(out.steps[0].id).toBe("fetch");
	});

	it("skips files starting with _ or .", async () => {
		await writeWorkflow("_helper.json", {
			name: "Helper",
			version: "1.0.0",
			trigger: { http: { method: "GET", path: "/" } },
			steps: [{ name: "x", node: "@blokjs/api-call", type: "module" }],
		});

		await migrateWorkflows({ stripLegacyPath: true, backup: false });

		const helper = JSON.parse(await fsp.readFile(path.join(tmpDir, "workflows", "json", "_helper.json"), "utf8"));
		// Untouched — still has v1 shape.
		expect(helper.steps[0].name).toBe("x");
		expect(helper.steps[0].id).toBeUndefined();
	});
});

describe("migrateWorkflows — error handling", () => {
	it("does not crash on invalid JSON; reports as error", async () => {
		const dir = path.join(tmpDir, "workflows", "json");
		await fsp.mkdir(dir, { recursive: true });
		await fsp.writeFile(path.join(dir, "broken.json"), "{ not valid json");

		await migrateWorkflows({ stripLegacyPath: true, backup: false });
		// process.exit(1) called — verify
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("exits 1 when no workflows directory found", async () => {
		// No workflows/json dir created
		await migrateWorkflows({ stripLegacyPath: true, backup: false });
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
