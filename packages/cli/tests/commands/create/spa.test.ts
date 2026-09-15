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
import { generateSharedNodesFile, generateSharedWorkflowsFile } from "../../../src/commands/create/project.js";
import {
	AUTH_NODES_IMPORT,
	AUTH_ROUTE_FILES,
	AUTH_WORKFLOWS_ENTRY_BLOCK,
	AUTH_WORKFLOWS_IMPORT_BLOCK,
	SESSION_NODES_IMPORT,
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
const GENERATED_WORKFLOWS = generateSharedWorkflowsFile(["http"]);

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
	// The REAL generator's output, so a change to either file that breaks the
	// splice anchors fails here instead of in a scaffolded project (#1018).
	fsExtra.writeFileSync(path.join(dir, "src", "Nodes.ts"), generateSharedNodesFile(["http"], ""));
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
			"src/components/AppLayout.tsx",
			"src/components/BlokLogo.tsx",
			"src/flash-toast.ts",
			"src/pages/Errors/Error.tsx",
			"src/pages/Home.tsx",
			// The design system (#1054): identical bytes in every template and
			// example, guarded by tests/docs/spa-design.test.ts.
			"src/styles/blok.css",
			"src/styles/theme.ts",
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

	it("3c. an unknown --kit is refused with the allowed list", async () => {
		await expect(scaffoldSpa("web", "react", { kit: "billing" })).rejects.toThrow(/Allowed: auth/);
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
		const homeWorkflow = fsExtra.readFileSync(path.join(workDir, "src/workflows/home.ts"), "utf8");
		expect(homeWorkflow).not.toContain("inertia-shell");
		// #1054 — the shell fills `{{title}}` from `viewData`, and the client's
		// `title:` callback only runs AFTER hydration. Without this the first paint
		// of a scaffolded app has an empty <title>.
		expect(homeWorkflow).toContain('viewData: { title: "Home" }');
		expect(files).toContain("client/vite.config.ts");
	});

	it("6b. add spa refuses an unknown --kit before touching the project", async () => {
		fakeBlokProject(workDir);
		const before = treeHash(workDir);
		await expect(
			addSpa({ framework: "react", install: false, kit: "billing" }, "0.0.0-test", REPO_ROOT),
		).rejects.toThrow(/Allowed: auth/);
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

	// =========================================================================
	// `--kit auth` — the auth starter kit (#1018)
	// =========================================================================

	it.each([
		["react", "tsx"],
		["vue", "vue"],
		["svelte", "svelte"],
	])("k1. --kit auth overlays the %s guest layout, the five pages and its stylesheet", async (framework, ext) => {
		const dest = await scaffoldSpa(`kit-${framework}`, framework, { kit: "auth" });
		const files = fileList(dest);

		for (const rel of [
			`src/components/GuestLayout.${ext}`,
			`src/pages/Auth/Login.${ext}`,
			`src/pages/Auth/Register.${ext}`,
			`src/pages/Auth/ForgotPassword.${ext}`,
			`src/pages/Auth/ResetPassword.${ext}`,
			`src/pages/Dashboard.${ext}`,
			// The kit's own CSS: `blok.css` ships by VALUE in seven clients and is
			// byte-compared, so a kit-only screen may not add to it.
			"src/styles/auth.css",
		]) {
			expect(files, `${framework}: ${rel} missing`).toContain(rel);
		}
		// The base template is still there underneath.
		expect(files).toContain(`src/pages/Home.${ext === "tsx" ? "tsx" : ext}`);
		// Each path appears ONCE, even the one the overlay replaces.
		expect(files.length).toBe(new Set(files).size);

		// The overlay wins for `blok-pages.d.ts`: without it `PageProps<"Dashboard">`
		// does not compile until the first `gen:types`.
		const pages = fsExtra.readFileSync(path.join(dest, "src/blok-pages.d.ts"), "utf8");
		expect(pages).toContain('"Auth/Login"');
		expect(pages).toContain('"Auth/ResetPassword"');
		expect(pages).toContain("Dashboard:");
		expect(pages).toContain("Home:");
	});

	it("k2. no --kit leaves every kit file out", async () => {
		const files = fileList(await scaffoldSpa("plain-kit", "react"));
		expect(files.filter((f) => f.includes("Auth/") || f.includes("GuestLayout") || f.includes("auth.css"))).toEqual([]);
		// ...and `kits/` is never copied as a directory of its own.
		expect(files.filter((f) => f.startsWith("kits/"))).toEqual([]);
	});

	it("k3. add spa --kit auth registers the kit's middleware, nodes and routes", async () => {
		fakeBlokProject(workDir);
		await addSpa({ framework: "react", install: false, kit: "auth" }, "0.0.0-test", REPO_ROOT);

		// The middleware chain comes from ONE package export.
		const workflows = fsExtra.readFileSync(path.join(workDir, "src", "Workflows.ts"), "utf8");
		expect(workflows).toContain(AUTH_WORKFLOWS_IMPORT_BLOCK);
		expect(workflows).toContain(AUTH_WORKFLOWS_ENTRY_BLOCK);
		// ...and NOT the kit-less registration, which would double-register
		// `inertia.shared` with the placeholder current-user node.
		expect(workflows).not.toContain(WORKFLOWS_IMPORT_BLOCK);
		expect(workflows).not.toContain(WORKFLOWS_ENTRY_BLOCK);
		// Biome sorts imports: `@blokjs/auth` before `@blokjs/helper`, or the
		// generated project fails its own lint.
		expect(workflows.indexOf('from "@blokjs/auth"')).toBeLessThan(workflows.indexOf('from "@blokjs/helper"'));

		// The kit's nodes are npm packages: `discoverNodes()` cannot see them, so
		// without an explicit registration every auth step fails at runtime.
		const nodes = fsExtra.readFileSync(path.join(workDir, "src", "Nodes.ts"), "utf8");
		// Each import lands at its own SORTED position, so they are asserted
		// separately rather than as one adjacent block (see k8).
		expect(nodes).toContain(AUTH_NODES_IMPORT);
		expect(nodes).toContain(SESSION_NODES_IMPORT);
		expect(nodes).toContain("...(Object.values(SESSION_NODES) as unknown as NodeBase[])");
		expect(nodes).toContain("...(Object.values(AUTH_NODES) as unknown as NodeBase[])");
		// The local-node discovery it splices into must survive.
		expect(nodes).toContain("...local]");

		// One file per route: the HTTP trigger auto-routes a file's DEFAULT export,
		// and `gen app-types` reads the page contracts by importing these files.
		const files = fileList(workDir);
		expect(Object.keys(AUTH_ROUTE_FILES)).toHaveLength(10);
		for (const name of Object.keys(AUTH_ROUTE_FILES)) {
			expect(files, `src/workflows/auth/${name} missing`).toContain(`src/workflows/auth/${name}`);
		}
		// #1018 security review M4 — the routes are the USER's files: real
		// `workflow()` declarations with a literal name, not re-export shims.
		// `blokctl gen app-types` parses that literal statically; the shims were
		// skipped, and every auth route vanished from the typed client index.
		for (const [name, source] of Object.entries(AUTH_ROUTE_FILES)) {
			expect(source, `${name} declares no literal workflow name`).toMatch(/workflow\(\s*"auth\.[A-Za-z]+"/);
			expect(source, `${name} is a re-export shim`).not.toContain("@blokjs/auth/examples");
		}
		const login = fsExtra.readFileSync(path.join(workDir, "src/workflows/auth/login.ts"), "utf8");
		expect(login).toContain('workflow("auth.login"');
		expect(login).toContain('trigger: http.post("/login")');
		// The validation → branch → bounce shape, editable in place.
		expect(login).toContain('step("validate", validate, { schema: LoginSchema, data: req.body })');
		expect(login).toContain("bounceNode");
		// The page contracts live in the workflow module that renders them, which
		// is what makes them visible to the generator's scan.
		expect(fsExtra.readFileSync(path.join(workDir, "src/workflows/auth/dashboard.ts"), "utf8")).toContain(
			'definePage("Dashboard"',
		);

		// The placeholder current-user node would only shadow @blokjs/auth's.
		expect(files).not.toContain("src/nodes/current-user/index.ts");
		expect(files).toContain("src/nodes/home-greeting/index.ts");
	});

	it("k4. add spa --kit auth generates the session secret and the SQLite driver", async () => {
		fakeBlokProject(workDir);
		await addSpa({ framework: "react", install: false, kit: "auth" }, "0.0.0-test", REPO_ROOT);

		const envLocal = fsExtra.readFileSync(path.join(workDir, ".env.local"), "utf8");
		// No default secret: a constant one is a forgeable session cookie, i.e.
		// signing in as any user.
		expect(envLocal).toMatch(/^BLOK_SESSION_SECRET=[0-9a-f]{64}$/m);
		expect(envLocal).toMatch(/^BLOK_FLASH_SECRET=[0-9a-f]{64}$/m);
		// The two secrets are independent.
		const secrets = [...envLocal.matchAll(/^BLOK_(?:SESSION|FLASH)_SECRET=([0-9a-f]{64})$/gm)].map((m) => m[1]);
		expect(new Set(secrets).size).toBe(2);
		// `inertia.session` runs FIRST — `inertia.shared`'s auth step reads what it
		// puts in state.
		// `inertia.encryptHistory` LAST: without it the client's history is never
		// encrypted and logout's clearHistory rotates a key protecting nothing.
		expect(envLocal).toContain(
			"BLOK_GLOBAL_MIDDLEWARE=inertia.session,inertia.shared,inertia.csrf,inertia.encryptHistory",
		);

		// The committed example keeps the shape and neither secret.
		const example = fsExtra.readFileSync(path.join(workDir, ".env.example"), "utf8");
		expect(example).toContain("BLOK_SESSION_SECRET=\n");
		expect(example).not.toMatch(/[0-9a-f]{64}/);

		const manifest = fsExtra.readJsonSync(path.join(workDir, "package.json")) as {
			dependencies: Record<string, string>;
		};
		expect(manifest.dependencies["@blokjs/session"]).toBeDefined();
		expect(manifest.dependencies["@blokjs/auth"]).toBeDefined();
		// `npm start` is `node dist/…`; without a driver the sqlite store throws on
		// the first request (Bun would be fine — it has bun:sqlite).
		expect(manifest.dependencies["better-sqlite3"]).toBeDefined();
	});

	it("k5. --local links the kit packages through overrides, like every other @blokjs dep", async () => {
		fakeBlokProject(workDir);
		await addSpa({ framework: "react", install: false, kit: "auth" }, "0.0.0-test", REPO_ROOT);

		const manifest = fsExtra.readJsonSync(path.join(workDir, "package.json")) as {
			dependencies: Record<string, string>;
			overrides: Record<string, string>;
			resolutions: Record<string, string>;
		};
		for (const pkg of ["@blokjs/session", "@blokjs/auth", "@blokjs/inertia"]) {
			expect(manifest.dependencies[pkg]).toMatch(/^file:/);
			expect(manifest.overrides[pkg]).toBe(manifest.dependencies[pkg]);
			expect(manifest.resolutions[pkg]).toBe(manifest.dependencies[pkg]);
		}
		// better-sqlite3 is a REAL npm package — overriding it with a file: link
		// would point it at nothing.
		expect(manifest.overrides["better-sqlite3"]).toBeUndefined();
	});

	it("k6. the auth pages post to the routes the kit actually serves", async () => {
		const dest = await scaffoldSpa("kit-routes", "react", { kit: "auth" });
		const pages = ["Auth/Login.tsx", "Auth/Register.tsx", "Auth/ForgotPassword.tsx", "Auth/ResetPassword.tsx"]
			.map((rel) => fsExtra.readFileSync(path.join(dest, "src/pages", rel), "utf8"))
			.join("\n");
		const layout = fsExtra.readFileSync(
			path.join(REPO_ROOT, "templates/spa-react/src/components/AppLayout.tsx"),
			"utf8",
		);

		// Every URL a page submits to, against the route table the kit registers.
		for (const [url, file] of [
			["/login", "login.ts"],
			["/register", "register.ts"],
			["/forgot-password", "forgot-password.ts"],
			["/logout", "logout.ts"],
		] as const) {
			const source = url === "/logout" ? layout : pages;
			expect(source, `no form posts to ${url}`).toContain(`"${url}"`);
			expect(Object.keys(AUTH_ROUTE_FILES), `${url} has no route file`).toContain(file);
		}
		// Sign out is a POST, never a GET link: a GET logout is CSRF-able and gets
		// pre-fetched.
		expect(layout).toContain('href="/logout" method="post"');
	});

	it("k7. every kit route file keeps its imports in Biome's sorted order", () => {
		for (const [name, source] of Object.entries(AUTH_ROUTE_FILES)) {
			const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1] as string);
			expect([...imports].sort(), `${name} has unsorted imports — the scaffold fails its own lint`).toEqual(imports);
		}
	});

	it("k8. the src/Nodes.ts splice lands at the sorted import positions", async () => {
		fakeBlokProject(workDir);
		await addSpa({ framework: "react", install: false, kit: "auth" }, "0.0.0-test", REPO_ROOT);

		const nodes = fsExtra.readFileSync(path.join(workDir, "src", "Nodes.ts"), "utf8");
		const position = (specifier: string): number => nodes.indexOf(`from "${specifier}"`);
		// Biome sorts imports and treats an unsorted block as an error (#1018
		// security review L2): api-call < auth < helpers … runner < shared < session.
		expect(position("@blokjs/api-call")).toBeLessThan(position("@blokjs/auth"));
		expect(position("@blokjs/auth")).toBeLessThan(position("@blokjs/if-else"));
		expect(position("@blokjs/shared")).toBeLessThan(position("@blokjs/session"));
	});

	it("k9. the kit's databases are gitignored — they hold password hashes and live sessions", async () => {
		fakeBlokProject(workDir);
		fsExtra.writeFileSync(path.join(workDir, ".gitignore"), "node_modules\n");
		await addSpa({ framework: "react", install: false, kit: "auth" }, "0.0.0-test", REPO_ROOT);

		const ignored = fsExtra.readFileSync(path.join(workDir, ".gitignore"), "utf8");
		expect(ignored).toContain(".blok/*.db");
		expect(ignored).toContain(".blok/*.db-wal");
		// Idempotent: a second look must not stack the block up again.
		expect(ignored.match(/\.blok\/\*\.db$/gm)?.length).toBe(1);
	});
});
