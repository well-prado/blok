import { spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * A scanned TS workflow importing a project-local module, loaded under PLAIN
 * Node — not vitest, whose transform rewrites `./x.js` → `./x.ts` for free.
 *
 * Node's type stripping resolves specifiers literally: `import "./greet.js"`
 * from a `.ts` file fails with ERR_MODULE_NOT_FOUND when only `greet.ts`
 * exists. `blokctl dev` (Bun) hides this, `node dist/triggers/http/index.js`
 * does not — the route silently never registers and the user sees a 404.
 * The scanner must resolve the `.ts` sibling itself.
 *
 * Skipped on a Node that cannot import TypeScript at all (< 22.18 unflagged).
 */
const SCANNER = path.resolve(__dirname, "../../src/runner/scanWorkflows.ts");
const nodeStripsTypes = spawnSync("node", ["-p", "process.features.typescript"], { encoding: "utf8" }).stdout.trim();
const d = nodeStripsTypes && nodeStripsTypes !== "false" && nodeStripsTypes !== "undefined" ? describe : describe.skip;

d("scanWorkflows — TS workflow importing a local `.js` sibling under plain Node", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "blok-scan-node-"));
	});

	afterEach(async () => {
		await fsp.rm(tmpDir, { recursive: true, force: true });
	});

	async function writeFixture(preamble = ""): Promise<{ root: string; script: string }> {
		const root = path.join(tmpDir, "src", "workflows");
		await fsp.mkdir(path.join(tmpDir, "src", "nodes"), { recursive: true });
		await fsp.mkdir(root, { recursive: true });
		await fsp.writeFile(
			path.join(tmpDir, "src", "nodes", "greet.ts"),
			"export const greet = (n: string) => `hi ${n}`;\n",
		);
		await fsp.writeFile(
			path.join(root, "hello.ts"),
			[
				'import { greet } from "../nodes/greet.js";',
				'export default { name: greet("scan"), version: "1.0.0", trigger: { http: { method: "GET" } } };',
				"",
			].join("\n"),
		);
		const script = path.join(tmpDir, "run.mjs");
		await fsp.writeFile(
			script,
			[
				preamble,
				`const { scanWorkflows } = await import(${JSON.stringify(SCANNER)});`,
				"const errors = [];",
				`const out = await scanWorkflows([{ dir: ${JSON.stringify(root)}, kind: "ts" }], { onLoadError: (f, e) => errors.push(e.message) });`,
				"console.log(JSON.stringify({ names: out.map((w) => w.name), errors }));",
				"",
			].join("\n"),
		);
		return { root, script };
	}

	function runScan(script: string): { names: string[]; errors: string[] } {
		const run = spawnSync("node", [script], { encoding: "utf8", cwd: tmpDir });
		expect(run.status, `node exited ${run.status}\n${run.stderr}`).toBe(0);
		return JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}");
	}

	it("loads the workflow instead of dropping it with ERR_MODULE_NOT_FOUND", async () => {
		const { script } = await writeFixture();
		const result = runScan(script);
		expect(result.errors).toEqual([]);
		expect(result.names).toEqual(["hi scan"]);
	});

	it("names the cause when the resolve hook is unavailable (Node < 22.15)", async () => {
		// Simulate an older Node: strip `registerHooks` before the scanner loads.
		const { script } = await writeFixture('import module from "node:module"; module.registerHooks = undefined;');
		const result = runScan(script);
		expect(result.names).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("greet.js");
		expect(result.errors[0]).toContain(".ts sibling exists");
	});
});
