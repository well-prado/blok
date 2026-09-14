/**
 * `blokctl create spa` / `blokctl add spa` — issue #999, unit tests 1-6.
 *
 * Everything here runs with `--no-install` against temp dirs, so it is the fast
 * lane: file lists, the framework-specific manifest, the refusals, idempotency
 * by tree hash, and the EXACT text spliced into an existing Blok project. What
 * a real `bun install && bun run build && bun run start` does with the result is
 * the scaffold-smoke e2e's job (`tests/e2e/scaffold-smoke/spa.sh`, tests 7-9).
 */
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fsExtra from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	STATIC_DIR_ENV,
	WORKFLOWS_ENTRY_BLOCK,
	WORKFLOWS_IMPORT_BLOCK,
	addSpa,
	createSpa,
	twoTerminalRecipe,
} from "../../../src/commands/create/spa.js";
import { setNonInteractive } from "../../../src/services/non-interactive.js";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");

/** `src/Workflows.ts` exactly as `createProject` generates it for an http-only scaffold. */
const GENERATED_WORKFLOWS = `import type { WorkflowV2Builder } from "@blokjs/helper";

// HTTP JSON + TS workflows are auto-discovered from workflows/json/ and workflows/**/*.ts

const workflows: Record<string, WorkflowV2Builder> = {
	// Add your workflows here
};

export default workflows;
`;

/** Stable hash of a directory tree: every relative path plus its content. */
function treeHash(dir: string): string {
	const hash = createHash("sha256");
	const walk = (current: string, rel: string): void => {
		for (const entry of fsExtra
			.readdirSync(current, { withFileTypes: true })
			.sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const next = path.join(current, entry.name);
			const nextRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if (entry.isDirectory()) {
				walk(next, nextRel);
				continue;
			}
			hash.update(nextRel).update("\0").update(fsExtra.readFileSync(next));
		}
	};
	walk(dir, "");
	return hash.digest("hex");
}

/** Every file in `dir`, relative and sorted — the snapshot subject. */
function fileList(dir: string): string[] {
	const out: string[] = [];
	const walk = (current: string, rel: string): void => {
		for (const entry of fsExtra.readdirSync(current, { withFileTypes: true })) {
			const nextRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if (entry.isDirectory()) walk(path.join(current, entry.name), nextRel);
			else out.push(nextRel);
		}
	};
	walk(dir, "");
	return out.sort();
}

/** A directory that passes `assertBlokProject` without a two-minute scaffold. */
function fakeBlokProject(dir: string): void {
	fsExtra.ensureDirSync(path.join(dir, "src"));
	fsExtra.writeJsonSync(
		path.join(dir, "package.json"),
		{
			name: "fake-blok-app",
			scripts: { build: "tsc", start: "node dist/triggers/http/index.js" },
			dependencies: { "@blokjs/trigger-http": "^2.3.0" },
		},
		{ spaces: "\t" },
	);
	fsExtra.writeFileSync(path.join(dir, "src", "Workflows.ts"), GENERATED_WORKFLOWS);
	fsExtra.writeFileSync(path.join(dir, ".env.local"), "PORT=4000\n");
	fsExtra.writeFileSync(path.join(dir, ".env.example"), "PORT=4000\n");
}

describe("blokctl create spa / add spa (#999)", () => {
	const origCwd = process.cwd();
	let workDir: string;

	beforeEach(() => {
		workDir = fsExtra.mkdtempSync(path.join(os.tmpdir(), "blok-spa-"));
		process.chdir(workDir);
		setNonInteractive(true);
		process.exitCode = undefined;
	});

	afterEach(() => {
		setNonInteractive(false);
		process.exitCode = undefined;
		process.chdir(origCwd);
		fsExtra.removeSync(workDir);
	});

	async function scaffoldSpa(name: string, framework: string, extra: Record<string, unknown> = {}): Promise<string> {
		return createSpa({ name, framework, install: false, ...extra }, "0.0.0-test", REPO_ROOT);
	}

	// --- test 1 --------------------------------------------------------------
	it("1. create spa --framework react --no-install writes the expected files and proxy target", async () => {
		const dest = await scaffoldSpa("web", "react");

		expect(fileList(dest)).toEqual([
			".gitignore",
			"index.html",
			"package.json",
			"src/app.tsx",
			"src/blok-pages.d.ts",
			"src/blok-routes.ts",
			"src/flash-toast.ts",
			"src/pages/Errors/Error.tsx",
			"src/pages/Home.tsx",
			"src/vite-env.d.ts",
			"tsconfig.json",
			"vite.config.ts",
		]);

		const viteConfig = fsExtra.readFileSync(path.join(dest, "vite.config.ts"), "utf8");
		// `blokInertia({ blokUrl })` from the issue body became
		// `blokInertia({ proxy: { target } })` when #997 merged — same knob.
		expect(viteConfig).toContain('proxy: { target: "http://localhost:4000" }');
		expect(viteConfig).toContain('import { blokInertia } from "@blokjs/inertia-client/vite"');
		// No install ran, so nothing resolved anything.
		expect(fsExtra.existsSync(path.join(dest, "node_modules"))).toBe(false);
	});

	it("1b. --blok-url is what the dev proxy targets", async () => {
		const dest = await scaffoldSpa("web", "react", { blokUrl: "http://127.0.0.1:4100" });
		expect(fsExtra.readFileSync(path.join(dest, "vite.config.ts"), "utf8")).toContain(
			'proxy: { target: "http://127.0.0.1:4100" }',
		);
	});

	// --- test 2 --------------------------------------------------------------
	it.each([
		["react", "@inertiajs/react", "src/app.tsx", "src/pages/Home.tsx", "@vitejs/plugin-react"],
		["vue", "@inertiajs/vue3", "src/app.ts", "src/pages/Home.vue", "@vitejs/plugin-vue"],
		["svelte", "@inertiajs/svelte", "src/app.ts", "src/pages/Home.svelte", "@sveltejs/vite-plugin-svelte"],
	])("2. %s scaffolds %s and its own entry/page/plugin", async (framework, adapter, entry, page, plugin) => {
		const dest = await scaffoldSpa(framework, framework);
		const manifest = fsExtra.readJsonSync(path.join(dest, "package.json")) as {
			dependencies: Record<string, string>;
			devDependencies: Record<string, string>;
		};

		expect(Object.keys(manifest.dependencies)).toContain(adapter);
		// Exactly ONE Inertia adapter — a leftover sibling would resolve pages twice.
		expect(Object.keys(manifest.dependencies).filter((d) => /^@inertiajs\/(react|vue3|svelte)$/.test(d))).toEqual([
			adapter,
		]);
		expect(Object.keys(manifest.devDependencies)).toContain(plugin);
		expect(manifest.dependencies["@blokjs/inertia-client"]).toBeDefined();
		expect(fileList(dest)).toContain(entry);
		expect(fileList(dest)).toContain(page);
	});

	// --- test 3 --------------------------------------------------------------
	it("3. --framework angular is refused, naming the missing Inertia adapter", async () => {
		await expect(scaffoldSpa("ng", "angular")).rejects.toThrow(/no official Inertia adapter for Angular/);
	});

	it("3b. an unknown framework is refused with the allowed list", async () => {
		await expect(scaffoldSpa("x", "ember")).rejects.toThrow(/Allowed: react, vue, svelte/);
	});

	it("3c. --kit auth is refused until #1018", async () => {
		await expect(scaffoldSpa("web", "react", { kit: "auth" })).rejects.toThrow(/#1018/);
	});

	// --- test 4 --------------------------------------------------------------
	it("4. add spa outside a Blok project exits 1", async () => {
		await expect(addSpa({ framework: "react", install: false }, "0.0.0-test", REPO_ROOT)).rejects.toThrow(
			/Not a Blok project/,
		);
		expect(fsExtra.existsSync(path.join(workDir, "client"))).toBe(false);

		// A package.json that is not a Blok one is refused too.
		fsExtra.writeJsonSync(path.join(workDir, "package.json"), { name: "unrelated" });
		await expect(addSpa({ framework: "react", install: false }, "0.0.0-test", REPO_ROOT)).rejects.toThrow(
			/declares no @blokjs\/\* dependency/,
		);
	});

	// --- test 5 --------------------------------------------------------------
	it("5. add spa twice is refused and changes nothing on the second run", async () => {
		fakeBlokProject(workDir);
		await addSpa({ framework: "react", install: false }, "0.0.0-test", REPO_ROOT);

		const before = treeHash(workDir);
		await expect(addSpa({ framework: "vue", install: false }, "0.0.0-test", REPO_ROOT)).rejects.toThrow(
			/Refusing to run twice/,
		);
		expect(treeHash(workDir)).toBe(before);
	});

	// --- test 6 --------------------------------------------------------------
	it("6. add spa splices the exact middleware, script and env text into the project", async () => {
		fakeBlokProject(workDir);
		await addSpa({ framework: "react", install: false }, "0.0.0-test", REPO_ROOT);

		const workflows = fsExtra.readFileSync(path.join(workDir, "src", "Workflows.ts"), "utf8");
		expect(workflows).toContain(WORKFLOWS_IMPORT_BLOCK);
		expect(workflows).toContain(WORKFLOWS_ENTRY_BLOCK);
		expect(workflows).toContain('"inertia.shared": await createSharedMiddleware({ currentUser })');
		expect(workflows).toContain('"inertia.csrf": await createCsrfMiddleware()');

		const manifest = fsExtra.readJsonSync(path.join(workDir, "package.json")) as {
			scripts: Record<string, string>;
			dependencies: Record<string, string>;
		};
		expect(manifest.scripts["build:client"]).toBe("cd client && npm run build");
		expect(manifest.scripts["dev:client"]).toBe("cd client && npm run dev");
		expect(manifest.scripts["gen:types"]).toBe("blokctl gen app-types --out client/src");
		// `bun run build` must build the client too.
		expect(manifest.scripts.build).toBe("tsc && npm run build:client");
		expect(manifest.dependencies["@blokjs/inertia"]).toBeDefined();

		// DEVIATION from the issue text: static serving is turned on with
		// `BLOK_STATIC_DIR` (#1000), not by editing the scaffold's AppRoutes.ts.
		const envLocal = fsExtra.readFileSync(path.join(workDir, ".env.local"), "utf8");
		expect(envLocal).toContain(STATIC_DIR_ENV);
		expect(envLocal).toContain("BLOK_GLOBAL_MIDDLEWARE=inertia.shared,inertia.csrf");
		// The flash cookie has NO default secret — the scaffold must generate one.
		expect(envLocal).toMatch(/^BLOK_FLASH_SECRET=[0-9a-f]{64}$/m);
		// ...and the committed example must never carry it.
		expect(fsExtra.readFileSync(path.join(workDir, ".env.example"), "utf8")).toContain("BLOK_FLASH_SECRET=\n");

		// The server half the example page needs.
		const files = fileList(workDir);
		expect(files).toContain("src/workflows/home.ts");
		expect(files).toContain("src/nodes/home-greeting/index.ts");
		expect(files).toContain("src/nodes/current-user/index.ts");
		// #1051 — the adapter's default shell loads the bundle from `.blok-vite.json`; no custom shell.
		expect(files).not.toContain("src/inertia-shell.ts");
		expect(fsExtra.readFileSync(path.join(workDir, "src/workflows/home.ts"), "utf8")).not.toContain("inertia-shell");
		expect(files).toContain("client/vite.config.ts");
	});

	it("6b. add spa refuses --kit auth before touching the project", async () => {
		fakeBlokProject(workDir);
		const before = treeHash(workDir);
		await expect(addSpa({ framework: "react", install: false, kit: "auth" }, "0.0.0-test", REPO_ROOT)).rejects.toThrow(
			/#1018/,
		);
		expect(treeHash(workDir)).toBe(before);
	});

	// --- --ssr ----------------------------------------------------------------
	it("--ssr adds the SSR entry, the build:ssr script and the vite ssr option; without it, none of the three", async () => {
		const plain = await scaffoldSpa("plain", "react");
		expect(fileList(plain)).not.toContain("src/ssr.tsx");
		expect(fsExtra.readJsonSync(path.join(plain, "package.json")).scripts["build:ssr"]).toBeUndefined();
		expect(fsExtra.readFileSync(path.join(plain, "vite.config.ts"), "utf8")).toContain("ssr: false");

		const ssr = await scaffoldSpa("ssr", "react", { ssr: true });
		expect(fileList(ssr)).toContain("src/ssr.tsx");
		expect(fsExtra.readJsonSync(path.join(ssr, "package.json")).scripts["build:ssr"]).toBe("vite build --ssr");
		expect(fsExtra.readFileSync(path.join(ssr, "vite.config.ts"), "utf8")).toContain('ssr: "src/ssr.tsx"');
	});

	// --- docs check -----------------------------------------------------------
	it("the printed two-terminal recipe matches what docs/d/spa/getting-started.mdx documents", () => {
		const recipe = twoTerminalRecipe({
			framework: "react",
			dir: "client",
			blokUrl: "http://localhost:4000",
			managerName: "npm",
			ssr: false,
		});
		const doc = fsExtra.readFileSync(path.join(REPO_ROOT, "docs/d/spa/getting-started.mdx"), "utf8");

		// Terminal 1 is the Blok server; terminal 2 is Vite proxying to it.
		expect(recipe).toContain("blokctl dev");
		expect(doc).toContain("blokctl dev");
		expect(recipe).toContain("http://localhost:4000");
		expect(doc).toContain("http://localhost:4000");
		expect(recipe).toContain("gen:types");
		// ...and the doc advertises the commands this file implements.
		expect(doc).toContain("blokctl create spa");
		expect(doc).toContain("blokctl add spa");
	});

	it("refuses to scaffold into a non-empty directory", async () => {
		fsExtra.ensureDirSync(path.join(workDir, "web"));
		fsExtra.writeFileSync(path.join(workDir, "web", "keep.txt"), "mine");
		await expect(scaffoldSpa("web", "react")).rejects.toThrow(/already exists and is not empty/);
		expect(fsExtra.readFileSync(path.join(workDir, "web", "keep.txt"), "utf8")).toBe("mine");
	});
});
