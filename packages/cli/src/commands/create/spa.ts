/**
 * `blokctl create spa` / `blokctl add spa` — the two Inertia SPA scaffolds (#999).
 *
 * Both write the SAME client from `templates/spa-{react,vue,svelte}/`; they
 * differ only in where it lands and what else gets wired:
 *
 * - **`create spa <name>`** — a standalone Vite project in its own directory.
 *   It talks to a Blok server over the dev proxy (`blokInertia({ proxy })`) or,
 *   deployed, cross-origin with `BLOK_CORS_ORIGIN` set on the Blok side.
 * - **`add spa`** — the same client at `client/` INSIDE a Blok project, plus
 *   the server half: `@blokjs/inertia`, the `inertia.shared` / `inertia.csrf`
 *   middleware registrations, an example `definePage` workflow, and
 *   `BLOK_STATIC_DIR=client/dist` so the HTTP trigger serves the build (#1000).
 *
 * The templates are COPIED FILES, not workspace packages: their manifest ships
 * as `package.json.template` (renamed on copy) precisely so the root
 * `bun.lock` never grows a `templates/spa-*` workspace entry.
 */

import child_process from "node:child_process";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import util from "node:util";
import * as p from "@clack/prompts";
import type { OptionValues } from "commander";
import fsExtra from "fs-extra";
import color from "picocolors";
import { isNonInteractive } from "../../services/non-interactive.js";
import { manager as pm } from "../../services/package-manager.js";
import { BLOKJS_DEP_RANGE } from "./project.js";

const exec = util.promisify(child_process.exec);

/** Frameworks with an official Inertia adapter. Angular has none — see {@link resolveFramework}. */
export const SPA_FRAMEWORKS = ["react", "vue", "svelte"] as const;
export type SpaFramework = (typeof SPA_FRAMEWORKS)[number];

/** Client directory `add spa` writes into, relative to the Blok project root. */
export const CLIENT_DIR = "client";

/** Where the built client is served from — the value written to `.env.local` (#1000). */
export const STATIC_DIR_ENV = `BLOK_STATIC_DIR=${CLIENT_DIR}/dist`;

/** Client entry filename per framework — also the SSR entry's sibling. */
const ENTRY_EXT: Record<SpaFramework, "ts" | "tsx"> = { react: "tsx", vue: "ts", svelte: "ts" };

/** npm package that proves a directory is a Blok project. */
const BLOK_MARKER = "@blokjs/";

const HOME_REPO = path.join(os.homedir(), ".blok", "blok");
/** Same bundle `create project` reads — `dist/commands/create/spa.js` → `dist/scaffold-repo`. */
const BUNDLED_SCAFFOLD_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scaffold-repo");

// =============================================================================
// Flag resolution
// =============================================================================

/**
 * Validate `--framework`. Angular gets its own message: the refusal is a
 * FACT about the ecosystem (no `@inertiajs/angular` exists), not a Blok
 * limitation, so saying "invalid value" would send people looking for a flag.
 */
export function resolveFramework(value: string): SpaFramework {
	const framework = value.trim().toLowerCase();
	if (framework === "angular") {
		throw new Error(
			"Angular is not supported: there is no official Inertia adapter for Angular " +
				"(@inertiajs/angular does not exist). Choose --framework react, vue or svelte.",
		);
	}
	if (!(SPA_FRAMEWORKS as readonly string[]).includes(framework)) {
		throw new Error(`Invalid value "${value}" for --framework. Allowed: ${SPA_FRAMEWORKS.join(", ")}.`);
	}
	return framework as SpaFramework;
}

/** `--kit auth` is #1018's wiring; refuse clearly instead of scaffolding half of it. */
export function resolveKit(value: string | undefined): void {
	if (value === undefined) return;
	if (value === "auth") {
		throw new Error("--kit auth is not available yet: the auth starter kit lands with #1018.");
	}
	throw new Error(`Invalid value "${value}" for --kit. The only planned kit is "auth" (#1018).`);
}

async function promptFramework(flag: string | undefined): Promise<SpaFramework> {
	if (flag !== undefined) return resolveFramework(String(flag));
	if (isNonInteractive()) {
		throw new Error(`Missing required flag --framework (non-interactive mode). Allowed: ${SPA_FRAMEWORKS.join(", ")}.`);
	}
	const picked = await p.select({
		message: "Which frontend framework?",
		options: [
			{ value: "react", label: "React 19" },
			{ value: "vue", label: "Vue 3.5" },
			{ value: "svelte", label: "Svelte 5" },
		],
	});
	if (p.isCancel(picked)) throw new Error("Cancelled.");
	return resolveFramework(String(picked));
}

// =============================================================================
// Template rendering
// =============================================================================

/** Locate `templates/spa-<framework>` — local repo, bundled assets, or the clone. */
export function spaTemplateDir(framework: SpaFramework, localRepoPath?: string): string {
	const roots = [
		localRepoPath === undefined ? undefined : path.resolve(localRepoPath),
		BUNDLED_SCAFFOLD_REPO,
		HOME_REPO,
	];
	for (const root of roots) {
		if (root === undefined) continue;
		const dir = path.join(root, "templates", `spa-${framework}`);
		if (fsExtra.existsSync(dir)) return dir;
	}
	throw new Error(`SPA template not found for "${framework}" (looked for templates/spa-${framework}).`);
}

/**
 * Files renamed on copy. `package.json.template` keeps `templates/spa-*` OUT of
 * the repo's `workspaces` glob (and therefore out of `bun.lock`); `gitignore`
 * survives `npm pack`, which strips a nested `.gitignore` from a tarball.
 */
const RENAME: Record<string, string> = { "package.json.template": "package.json", gitignore: ".gitignore" };

export interface RenderSpaOptions {
	framework: SpaFramework;
	/** Absolute destination directory. Created if missing. */
	dest: string;
	/** `name` field of the generated package.json, and the fallback `<title>`. */
	name: string;
	/** Blok server the Vite dev proxy forwards to. */
	blokUrl: string;
	/** Emit `src/ssr.*` + the `build:ssr` script. */
	ssr: boolean;
	/** Range for `@blokjs/*` template deps, or a `file:` link under `--local`. */
	depRange: string;
	/** `blokctl` devDependency — `file:` link under `--local`. */
	cliRange: string;
	localRepoPath?: string;
}

/**
 * Copy one template, substituting the `__BLOK_*__` tokens. Every file in a SPA
 * template is text, so there is no binary path to special-case.
 */
export function renderSpaTemplate(opts: RenderSpaOptions): string[] {
	const source = spaTemplateDir(opts.framework, opts.localRepoPath);
	const entryExt = ENTRY_EXT[opts.framework];
	const tokens: Record<string, string> = {
		__BLOK_SPA_NAME__: opts.name,
		__BLOK_URL__: opts.blokUrl,
		__BLOK_SSR__: opts.ssr ? JSON.stringify(`src/ssr.${entryExt}`) : "false",
		__BLOK_DEP_RANGE__: opts.depRange,
	};

	const written: string[] = [];
	const walk = (dir: string, rel: string): void => {
		for (const entry of fsExtra
			.readdirSync(dir, { withFileTypes: true })
			.sort((a, b) => a.name.localeCompare(b.name))) {
			const from = path.join(dir, entry.name);
			const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if (entry.isDirectory()) {
				walk(from, relPath);
				continue;
			}
			// The SSR entry only ships with --ssr; without it the file would be
			// dead weight AND would flip `@inertiajs/vite`'s SSR auto-detection on.
			if (!opts.ssr && entry.name.startsWith("ssr.")) continue;
			const outRel = rel === "" ? (RENAME[entry.name] ?? entry.name) : relPath;
			const to = path.join(opts.dest, outRel);
			let text = fsExtra.readFileSync(from, "utf8");
			for (const [token, value] of Object.entries(tokens)) text = text.split(token).join(value);
			fsExtra.ensureDirSync(path.dirname(to));
			fsExtra.writeFileSync(to, text);
			written.push(outRel);
		}
	};
	walk(source, "");

	// Manifest touch-ups that are cheaper as JSON than as more tokens.
	const manifestPath = path.join(opts.dest, "package.json");
	const manifest = JSON.parse(fsExtra.readFileSync(manifestPath, "utf8")) as {
		scripts: Record<string, string>;
		devDependencies: Record<string, string>;
	};
	if (!opts.ssr) {
		manifest.scripts = Object.fromEntries(Object.entries(manifest.scripts).filter(([name]) => name !== "build:ssr"));
	}
	manifest.devDependencies.blokctl = opts.cliRange;
	fsExtra.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);

	return written.sort();
}

// =============================================================================
// `blokctl create spa <name>`
// =============================================================================

function linkOrRange(rel: string, localRepoPath: string | undefined): string {
	return localRepoPath === undefined ? BLOKJS_DEP_RANGE : `file:${path.resolve(localRepoPath, rel)}`;
}

async function installIn(dir: string, managerName: string): Promise<void> {
	const manager = await pm.getManager(managerName);
	await exec(manager.INSTALL, { cwd: dir, maxBuffer: 32 * 1024 * 1024 });
}

export async function createSpa(opts: OptionValues, _version: string, localRepoPath?: string): Promise<string> {
	resolveKit(opts.kit as string | undefined);
	const framework = await promptFramework(opts.framework as string | undefined);

	let name = (opts.name as string | undefined) ?? "";
	if (name === "") {
		if (isNonInteractive()) throw new Error("Missing required argument <name> (non-interactive mode).");
		const answer = await p.text({ message: "SPA directory name", placeholder: "web" });
		if (p.isCancel(answer)) throw new Error("Cancelled.");
		name = String(answer);
	}

	const dest = path.resolve(process.cwd(), name);
	if (fsExtra.existsSync(dest) && fsExtra.readdirSync(dest).length > 0) {
		throw new Error(`Refusing to scaffold into "${name}": the directory already exists and is not empty.`);
	}

	const blokUrl = (opts.blokUrl as string | undefined) ?? "http://localhost:4000";
	const managerName = (opts.pm as string | undefined) ?? (opts.packageManager as string | undefined) ?? "npm";

	renderSpaTemplate({
		framework,
		dest,
		name,
		blokUrl,
		ssr: opts.ssr === true,
		depRange: linkOrRange("packages/inertia-client", localRepoPath),
		cliRange: linkOrRange("packages/cli", localRepoPath),
		localRepoPath,
	});

	if (opts.install !== false) await installIn(dest, managerName);

	console.log(color.green(`\n✅ ${framework} SPA created at ${name}/`));
	console.log(twoTerminalRecipe({ framework, dir: name, blokUrl, managerName, ssr: opts.ssr === true }));
	return dest;
}

/**
 * The two-terminal recipe. Printed by BOTH commands and asserted by the CLI
 * tests, so the docs page (#1004) has exactly one wording to match.
 */
export function twoTerminalRecipe(args: {
	framework: SpaFramework;
	dir: string;
	blokUrl: string;
	managerName: string;
	ssr: boolean;
}): string {
	const run = `${args.managerName} run`;
	const lines = [
		"",
		"Two terminals:",
		`  1. In your Blok project:  blokctl dev          (serves ${args.blokUrl})`,
		`  2. In ${args.dir}/:  ${run} dev              (Vite, proxying to Blok)`,
		"",
		`Then open the Vite URL — every non-asset request is proxied to ${args.blokUrl}.`,
		`Regenerate the typed pages and routes with: ${run} gen:types`,
	];
	if (args.ssr) {
		lines.push(
			"",
			`SSR: ${run} build && ${run} build:ssr, then \`blokctl inertia start-ssr\` next to the Blok server.`,
		);
	}
	return lines.join("\n");
}

// =============================================================================
// `blokctl add spa`
// =============================================================================

/** Inserted into `src/Workflows.ts` — exported so the test asserts the EXACT text. */
export const WORKFLOWS_IMPORT_BLOCK = `import { createCsrfMiddleware, createSharedMiddleware } from "@blokjs/inertia";
import currentUser from "./nodes/current-user/index.js";
`;

/** Inserted into the `workflows` map in `src/Workflows.ts`. */
export const WORKFLOWS_ENTRY_BLOCK = `\t// Inertia SPA (blokctl add spa). Both run on every request — see
\t// BLOK_GLOBAL_MIDDLEWARE in .env.local.
\t"inertia.shared": await createSharedMiddleware({ currentUser }),
\t"inertia.csrf": await createCsrfMiddleware(),
`;

/** The `.env` block, minus the generated secret. */
export function envBlock(flashSecret: string): string {
	return `
# --- Inertia SPA (blokctl add spa) ---
# Root of the built client. Mounts /assets/* and publishes ASSET_VERSION (#1000).
${STATIC_DIR_ENV}
# Signing secret for the one-shot flash cookie. There is NO default.
BLOK_FLASH_SECRET=${flashSecret}
# Shared props (auth + flash) then the double-submit CSRF guard, on every request.
BLOK_GLOBAL_MIDDLEWARE=inertia.shared,inertia.csrf
`;
}

/** Throws unless `dir` looks like a Blok project. */
export function assertBlokProject(dir: string): void {
	const manifestPath = path.join(dir, "package.json");
	if (!fsExtra.existsSync(manifestPath)) {
		throw new Error(`Not a Blok project: no package.json in ${dir}. Run \`blokctl add spa\` inside a Blok project.`);
	}
	const manifest = JSON.parse(fsExtra.readFileSync(manifestPath, "utf8")) as {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
	if (!deps.some((dep) => dep.startsWith(BLOK_MARKER) || dep === "blokctl")) {
		throw new Error(
			`Not a Blok project: ${manifestPath} declares no @blokjs/* dependency. Run \`blokctl add spa\` inside a project created by \`blokctl create project\`.`,
		);
	}
	if (!fsExtra.existsSync(path.join(dir, "src", "Workflows.ts"))) {
		throw new Error(`Not a Blok project: ${path.join(dir, "src/Workflows.ts")} is missing.`);
	}
}

/** `src/Workflows.ts` with the two middleware registrations spliced in. */
export function patchWorkflowsSource(source: string): string {
	if (source.includes('"inertia.shared"')) return source;
	const openMarker = "const workflows: Record<string, WorkflowV2Builder> = {\n";
	if (!source.includes(openMarker)) {
		throw new Error("Could not find the workflow registry in src/Workflows.ts — add the Inertia middleware by hand.");
	}
	const imported = source.replace(
		'import type { WorkflowV2Builder } from "@blokjs/helper";\n',
		`import type { WorkflowV2Builder } from "@blokjs/helper";\n${WORKFLOWS_IMPORT_BLOCK}`,
	);
	return imported.replace(openMarker, `${openMarker}${WORKFLOWS_ENTRY_BLOCK}`);
}

/** Append a block to a dotenv file, creating it when absent. */
function appendEnv(file: string, block: string): void {
	const current = fsExtra.existsSync(file) ? fsExtra.readFileSync(file, "utf8") : "";
	if (current.includes(STATIC_DIR_ENV)) return;
	fsExtra.writeFileSync(file, current.endsWith("\n") || current === "" ? current + block : `${current}\n${block}`);
}

export async function addSpa(opts: OptionValues, _version: string, localRepoPath?: string): Promise<string> {
	resolveKit(opts.kit as string | undefined);
	const projectDir = path.resolve((opts.cwd as string | undefined) ?? process.cwd());

	// Both guards BEFORE anything is written — `add spa` twice must leave the
	// tree byte-identical (issue #999 test 5).
	assertBlokProject(projectDir);
	const clientDir = path.join(projectDir, CLIENT_DIR);
	if (fsExtra.existsSync(clientDir)) {
		throw new Error(`Refusing to run twice: ${clientDir} already exists. Delete it first to re-scaffold.`);
	}

	const framework = await promptFramework(opts.framework as string | undefined);
	const managerName = (opts.pm as string | undefined) ?? (opts.packageManager as string | undefined) ?? "npm";
	const blokUrl = (opts.blokUrl as string | undefined) ?? "http://localhost:4000";
	const manifestPath = path.join(projectDir, "package.json");
	const manifest = JSON.parse(fsExtra.readFileSync(manifestPath, "utf8")) as {
		name?: string;
		scripts?: Record<string, string>;
		dependencies?: Record<string, string>;
		imports?: Record<string, unknown>;
		overrides?: Record<string, string>;
		resolutions?: Record<string, string>;
	};

	renderSpaTemplate({
		framework,
		dest: clientDir,
		name: `${manifest.name ?? "blok-app"}-client`,
		blokUrl,
		ssr: opts.ssr === true,
		depRange: linkOrRange("packages/inertia-client", localRepoPath),
		cliRange: linkOrRange("packages/cli", localRepoPath),
		localRepoPath,
	});

	// --- server half ---------------------------------------------------------
	// `#app/*` — the ONE way a scanned TS workflow can import a project-local
	// module and still run under `node dist/…`. The HTTP trigger's TS auto-router
	// scans `src/workflows/**` and dynamic-imports the SOURCE file even in a
	// built process (#695); Node's type stripping does NOT rewrite a relative
	// `./x.js` specifier to `./x.ts`, so `import … from "../nodes/x/index.js"`
	// dies with ERR_MODULE_NOT_FOUND the moment the project is started with
	// Node rather than Bun. A subpath import resolves per RUNTIME instead: Bun
	// (`blokctl dev`) takes the TypeScript source, Node takes the build output.
	manifest.imports = {
		...manifest.imports,
		"#app/*": { bun: "./src/*.ts", node: "./dist/*.js", default: "./src/*.ts" },
	};
	const inertiaDep = linkOrRange("nodes/web/inertia", localRepoPath);
	manifest.dependencies = { ...manifest.dependencies, "@blokjs/inertia": inertiaDep };
	if (localRepoPath !== undefined) {
		// Mirror `create project --local`: the file:-linked node resolves its own
		// @blokjs/* deps through these, instead of 404-ing on an unpublished npm
		// version.
		manifest.overrides = { ...manifest.overrides, "@blokjs/inertia": inertiaDep };
		manifest.resolutions = { ...manifest.resolutions, "@blokjs/inertia": inertiaDep };
	}
	const run = `${managerName} run`;
	const scripts = manifest.scripts ?? {};
	scripts["dev:client"] = `cd ${CLIENT_DIR} && ${run} dev`;
	scripts["build:client"] = `cd ${CLIENT_DIR} && ${run} build`;
	scripts["gen:types"] = `blokctl gen app-types --out ${CLIENT_DIR}/src`;
	const build = scripts.build;
	if (typeof build === "string" && !build.includes("build:client")) {
		scripts.build = `${build} && ${run} build:client`;
	}
	manifest.scripts = scripts;
	fsExtra.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);

	const block = envBlock(randomBytes(32).toString("hex"));
	appendEnv(path.join(projectDir, ".env.local"), block);
	// The committed example keeps the shape but never the secret.
	appendEnv(path.join(projectDir, ".env.example"), envBlock(""));

	const workflowsPath = path.join(projectDir, "src", "Workflows.ts");
	fsExtra.writeFileSync(workflowsPath, patchWorkflowsSource(fsExtra.readFileSync(workflowsPath, "utf8")));

	fsExtra.ensureDirSync(path.join(projectDir, "src", "nodes", "current-user"));
	fsExtra.writeFileSync(path.join(projectDir, "src", "nodes", "current-user", "index.ts"), CURRENT_USER_NODE);
	fsExtra.ensureDirSync(path.join(projectDir, "src", "nodes", "home-greeting"));
	fsExtra.writeFileSync(path.join(projectDir, "src", "nodes", "home-greeting", "index.ts"), HOME_GREETING_NODE);
	fsExtra.ensureDirSync(path.join(projectDir, "src", "workflows"));
	fsExtra.writeFileSync(path.join(projectDir, "src", "workflows", "home.ts"), HOME_WORKFLOW);

	if (opts.install !== false) {
		await installIn(projectDir, managerName);
		await installIn(clientDir, managerName);
	}

	console.log(color.green(`\n✅ ${framework} client added at ${CLIENT_DIR}/`));
	console.log(`   ${run} build   builds the server AND the client into ${CLIENT_DIR}/dist`);
	console.log(`   ${run} start   serves / as an Inertia page and /assets/* from ${CLIENT_DIR}/dist`);
	console.log(twoTerminalRecipe({ framework, dir: CLIENT_DIR, blokUrl, managerName, ssr: opts.ssr === true }));
	return clientDir;
}

// =============================================================================
// Generated server-side sources
// =============================================================================

const CURRENT_USER_NODE = `import { defineNode } from "@blokjs/core";
import { z } from "zod";

/**
 * Who is logged in. The \`inertia.shared\` middleware calls this on every
 * request and persists the result at \`ctx.state.auth\`, which every page then
 * reads as the \`auth\` shared prop.
 *
 * The scaffold ships the guest answer — replace the body with your own session
 * lookup.
 */
export default defineNode({
	name: "current-user",
	description: "Resolve the authenticated user for Inertia's shared props.",
	input: z.object({
		headers: z.record(z.string()).optional(),
	}),
	output: z.object({
		id: z.string().nullable(),
		name: z.string().nullable(),
	}),
	async execute(_ctx, _input) {
		return { id: null, name: null };
	},
});
`;

const HOME_GREETING_NODE = `import { defineNode } from "@blokjs/core";
import { z } from "zod";

/**
 * One page prop, one node. The Zod \`output\` schema is what
 * \`blokctl gen app-types\` turns into the \`home: { title, body }\` field of
 * \`PageProps<"Home">\` on the client.
 */
export default defineNode({
	name: "home-greeting",
	description: "Copy for the example Inertia home page.",
	input: z.object({}),
	output: z.object({
		title: z.string(),
		body: z.string(),
	}),
	async execute() {
		return {
			title: "Hello from Blok",
			body: "This page is a Blok workflow. Every prop is a step — in any runtime — and navigation is the Inertia protocol.",
		};
	},
});
`;

const HOME_WORKFLOW = `import { http, workflow } from "@blokjs/core";
import { definePage } from "@blokjs/inertia";
// \`#app/*\` — a package.json subpath import, not a relative path. The HTTP
// trigger's TS auto-router imports THIS SOURCE FILE even in a built process,
// and Node does not rewrite \`./x.js\` to \`./x.ts\`; the subpath resolves to the
// source under Bun and to \`dist/\` under Node, so both work unchanged.
import homeGreeting from "#app/nodes/home-greeting/index";

/**
 * The page CONTRACT, declared outside the workflow callback so the client can
 * \`import type\` it (and so \`blokctl gen app-types\` can read it). Each key is a
 * prop; each value is the node that produces it, in any runtime.
 */
export const Home = definePage("Home", {
	home: homeGreeting,
});

// No shell here: \`@blokjs/inertia\`'s default shell reads \`.blok-vite.json\`
// from \`BLOK_STATIC_DIR\` (written by the Vite plugin in dev AND build), so the
// page loads the right bundle in both, and the asset version rides along for
// Inertia's stale-asset reload.
export default workflow("home", { version: "1.0.0", trigger: http.get("/") }, (req) => {
	Home.render(req, "page", "/", {}, { viewData: { title: "Home" } });
});
`;
