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
import { AUTH_ROUTE_FILES } from "./auth-kit-workflows.js";
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

/**
 * SQLite driver range for `--kit auth`. `@blokjs/session` declares it as an
 * OPTIONAL peer (Bun needs nothing), so the range lives here: a scaffold that
 * starts with `node dist/…` must have a real driver installed.
 */
const SQLITE_RANGE = "^12.6.2";

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

export { AUTH_ROUTE_FILES } from "./auth-kit-workflows.js";

/** Starter kits `--kit` accepts. One so far: the auth slice (#1018). */
export const SPA_KITS = ["auth"] as const;
export type SpaKit = (typeof SPA_KITS)[number];

/** Validate `--kit`. `undefined` (no kit) is the default and not an error. */
export function resolveKit(value: string | undefined): SpaKit | undefined {
	if (value === undefined) return undefined;
	const kit = String(value).trim().toLowerCase();
	if ((SPA_KITS as readonly string[]).includes(kit)) return kit as SpaKit;
	throw new Error(`Invalid value "${value}" for --kit. Allowed: ${SPA_KITS.join(", ")}.`);
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
	/** Starter kit whose client half is overlaid on top of the base template. */
	kit?: SpaKit;
	localRepoPath?: string;
}

/**
 * Copy one template, substituting the `__BLOK_*__` tokens. Every file in a SPA
 * template is text, so there is no binary path to special-case.
 *
 * A `--kit` overlays `templates/spa-<fw>/kits/<kit>/` on top, LAST, so a kit
 * file with the same path wins (the auth kit replaces the placeholder
 * `src/blok-pages.d.ts` with one that also declares its five pages).
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
			// `kits/` is the OPT-IN half of the template, overlaid below.
			if (rel === "" && entry.name === "kits") continue;
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
	if (opts.kit !== undefined) {
		const kitDir = path.join(source, "kits", opts.kit);
		if (!fsExtra.existsSync(kitDir)) {
			throw new Error(`The "${opts.kit}" kit has no ${opts.framework} client (looked for ${kitDir}).`);
		}
		walk(kitDir, "");
	}

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

	// A kit file can replace a base file (`src/blok-pages.d.ts`), so the list is
	// a SET: the caller's file list must name every path once.
	return [...new Set(written)].sort();
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
	const kit = resolveKit(opts.kit as string | undefined);
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
		...(kit === undefined ? {} : { kit }),
		localRepoPath,
	});

	if (opts.install !== false) await installIn(dest, managerName);

	console.log(color.green(`\n✅ ${framework} SPA created at ${name}/`));
	if (kit === "auth") {
		// A standalone SPA is only the CLIENT half: the pages POST to /login,
		// /register and /logout, which exist on the BLOK side and are wired by
		// `blokctl add spa --kit auth` there.
		console.log(
			color.yellow(
				`   The auth pages need the kit's server half on ${blokUrl}:\n   run \`blokctl add spa --kit auth\` in the Blok project (see https://blok.build/d/spa/starter-kit).`,
			),
		);
	}
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

/**
 * The `.env` block, minus the generated secrets.
 *
 * Both secrets are GENERATED, never defaulted: a constant flash secret lets
 * anyone forge a flash message, and a constant session secret lets anyone forge
 * a session cookie, i.e. sign in as any user. `.env.example` gets the same
 * block with the values blank.
 */
export function envBlock(flashSecret: string, kit?: SpaKit, sessionSecret = ""): string {
	// `inertia.encryptHistory` is what makes logout's `clearHistory` mean
	// anything: without it nothing in the client's history is encrypted and the
	// key rotation on sign-out protects nothing (#1018 security review B3).
	const chain =
		kit === "auth"
			? "inertia.session,inertia.shared,inertia.csrf,inertia.encryptHistory"
			: "inertia.shared,inertia.csrf";
	const base = `
# --- Inertia SPA (blokctl add spa) ---
# Root of the built client. Mounts /assets/* and publishes ASSET_VERSION (#1000).
${STATIC_DIR_ENV}
# Signing secret for the one-shot flash cookie. There is NO default.
BLOK_FLASH_SECRET=${flashSecret}
# Shared props (auth + flash) then the double-submit CSRF guard, on every request.
BLOK_GLOBAL_MIDDLEWARE=${chain}
`;
	if (kit !== "auth") return base;
	return `${base}
# --- Auth starter kit (--kit auth) ---
# Signs the session cookie. There is NO default; changing it signs everyone out.
BLOK_SESSION_SECRET=${sessionSecret}
# Sessions and users default to SQLite files under .blok/ — delete them to start
# over. BLOK_SESSION_STORE=memory for a throwaway dev run, or set REDIS_URL to
# share sessions across processes.
# BLOK_SESSION_SQLITE_PATH=.blok/sessions.db
# BLOK_AUTH_SQLITE_PATH=.blok/auth.db
# Set this ONLY when a reverse proxy you control is in front: it lets
# X-Forwarded-For name the client for login throttling. Anyone can send that
# header, so trusting it without a proxy gives an attacker a fresh throttle
# bucket per attempt.
# BLOK_TRUST_PROXY=1
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

/**
 * `--kit auth` (#1018): the whole middleware chain comes from one package
 * export, so the registration is a spread rather than four lines that can
 * drift from what `@blokjs/auth` actually ships.
 */
export const AUTH_WORKFLOWS_IMPORT_BLOCK = `import { authKitMiddleware } from "@blokjs/auth";
`;

/** Inserted into the `workflows` map by `--kit auth` — instead of {@link WORKFLOWS_ENTRY_BLOCK}. */
export const AUTH_WORKFLOWS_ENTRY_BLOCK = `\t// Auth starter kit (blokctl add spa --kit auth): inertia.session →
\t// inertia.shared → inertia.csrf on every request (the order is in
\t// BLOK_GLOBAL_MIDDLEWARE in .env.local), plus the per-route inertia.auth
\t// guard that src/workflows/auth/dashboard.ts asks for.
\t//
\t// The cast is the package boundary: authKitMiddleware() returns built
\t// workflows typed as \`unknown\` so @blokjs/auth need not depend on the
\t// runner's types.
\t...((await authKitMiddleware()) as Record<string, WorkflowV2Builder>),
`;

/** `src/Workflows.ts` with the middleware registrations for `kit` spliced in. */
export function patchWorkflowsSource(source: string, kit?: SpaKit): string {
	const importBlock = kit === "auth" ? AUTH_WORKFLOWS_IMPORT_BLOCK : WORKFLOWS_IMPORT_BLOCK;
	const entryBlock = kit === "auth" ? AUTH_WORKFLOWS_ENTRY_BLOCK : WORKFLOWS_ENTRY_BLOCK;
	if (source.includes(importBlock)) return source;
	const openMarker = "const workflows: Record<string, WorkflowV2Builder> = {\n";
	if (!source.includes(openMarker)) {
		throw new Error("Could not find the workflow registry in src/Workflows.ts — add the Inertia middleware by hand.");
	}
	// Biome sorts imports and treats an unsorted block as an error, so the kit's
	// `@blokjs/auth` line goes BEFORE `@blokjs/helper` and the base block's
	// `@blokjs/inertia` line after it.
	const helper = 'import type { WorkflowV2Builder } from "@blokjs/helper";\n';
	const imported = source.replace(helper, kit === "auth" ? `${importBlock}${helper}` : `${helper}${importBlock}`);
	return imported.replace(openMarker, `${openMarker}${entryBlock}`);
}

/**
 * The two imports `--kit auth` splices into `src/Nodes.ts`, each at its
 * sorted position (`@blokjs/auth` before `@blokjs/if-else`, `@blokjs/session`
 * after `@blokjs/shared`). Exported so the test asserts the EXACT text.
 */
export const AUTH_NODES_IMPORT = `import { AUTH_NODES } from "@blokjs/auth";\n`;
export const SESSION_NODES_IMPORT = `import { SESSION_NODES } from "@blokjs/session";\n`;
/** Both lines, for a test that only cares that the registrations are there. */
export const AUTH_NODES_IMPORT_BLOCK = `${AUTH_NODES_IMPORT}${SESSION_NODES_IMPORT}`;

/** The kit's node registrations, spliced into the loop `src/Nodes.ts` builds its map with. */
export const AUTH_NODES_ENTRY =
	"...(Object.values(SESSION_NODES) as unknown as NodeBase[]), ...(Object.values(AUTH_NODES) as unknown as NodeBase[]), ";

/**
 * `src/Nodes.ts` with the kit's nodes registered.
 *
 * They are npm packages, not files under `src/nodes/`, so `discoverNodes()`
 * cannot find them: a published node is registered explicitly, exactly like
 * `@blokjs/api-call` in the same file. Without this every auth step fails with
 * "Node @blokjs/auth.login not found".
 */
export function patchNodesSource(source: string): string {
	if (source.includes("AUTH_NODES")) return source;
	const marker = ", ...local]";
	const anchors =
		source.includes(marker) &&
		source.includes('import IfElse from "@blokjs/if-else";') &&
		source.includes('import type { NodeBase } from "@blokjs/shared";');
	if (!anchors) {
		throw new Error(
			"Could not find the node registry in src/Nodes.ts — register @blokjs/session's and @blokjs/auth's nodes by hand.",
		);
	}
	// Biome sorts imports: `@blokjs/auth` goes after `@blokjs/api-call` and
	// before `@blokjs/helpers`, and `@blokjs/session` after `@blokjs/runner` —
	// so each line is spliced at its sorted position rather than appended
	// (#1018 security review L2).
	return source
		.replace('import IfElse from "@blokjs/if-else";\n', `${AUTH_NODES_IMPORT}import IfElse from "@blokjs/if-else";\n`)
		.replace(
			'import type { NodeBase } from "@blokjs/shared";\n',
			`import type { NodeBase } from "@blokjs/shared";\n${SESSION_NODES_IMPORT}`,
		)
		.replace(marker, `, ${AUTH_NODES_ENTRY}...local]`);
}

/** The `.gitignore` rule for the kit's SQLite files — exported so the test asserts it. */
export const KIT_GITIGNORE_BLOCK = `
# Auth starter kit: the user table and live sessions (blokctl add spa --kit auth)
.blok/*.db
.blok/*.db-shm
.blok/*.db-wal
`;

/** Add {@link KIT_GITIGNORE_BLOCK} to `file`, once. */
function ignoreKitDatabases(file: string): void {
	const current = fsExtra.existsSync(file) ? fsExtra.readFileSync(file, "utf8") : "";
	if (current.includes(".blok/*.db")) return;
	fsExtra.writeFileSync(
		file,
		current === "" || current.endsWith("\n") ? current + KIT_GITIGNORE_BLOCK : `${current}\n${KIT_GITIGNORE_BLOCK}`,
	);
}

/** Append a block to a dotenv file, creating it when absent. */
function appendEnv(file: string, block: string): void {
	const current = fsExtra.existsSync(file) ? fsExtra.readFileSync(file, "utf8") : "";
	if (current.includes(STATIC_DIR_ENV)) return;
	fsExtra.writeFileSync(file, current.endsWith("\n") || current === "" ? current + block : `${current}\n${block}`);
}

export async function addSpa(opts: OptionValues, _version: string, localRepoPath?: string): Promise<string> {
	const kit = resolveKit(opts.kit as string | undefined);
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
		...(kit === undefined ? {} : { kit }),
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
	const blokDeps: Record<string, string> = { "@blokjs/inertia": linkOrRange("nodes/web/inertia", localRepoPath) };
	if (kit === "auth") {
		blokDeps["@blokjs/session"] = linkOrRange("packages/session", localRepoPath);
		blokDeps["@blokjs/auth"] = linkOrRange("packages/auth", localRepoPath);
	}
	manifest.dependencies = {
		...manifest.dependencies,
		...blokDeps,
		// The kit's default session and user stores are SQLite files. Bun has
		// `bun:sqlite` built in, but `npm start` is `node dist/…`, and Node needs
		// a driver — so this DEPENDENCY is what makes the scaffold work on first
		// run instead of throwing on the first request.
		...(kit === "auth" ? { "better-sqlite3": SQLITE_RANGE } : {}),
	};
	if (localRepoPath !== undefined) {
		// Mirror `create project --local`: the file:-linked node resolves its own
		// @blokjs/* deps through these, instead of 404-ing on an unpublished npm
		// version.
		manifest.overrides = { ...manifest.overrides, ...blokDeps };
		manifest.resolutions = { ...manifest.resolutions, ...blokDeps };
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

	const block = envBlock(randomBytes(32).toString("hex"), kit, randomBytes(32).toString("hex"));
	appendEnv(path.join(projectDir, ".env.local"), block);
	// The committed example keeps the shape but never the secrets.
	appendEnv(path.join(projectDir, ".env.example"), envBlock("", kit));

	const workflowsPath = path.join(projectDir, "src", "Workflows.ts");
	fsExtra.writeFileSync(workflowsPath, patchWorkflowsSource(fsExtra.readFileSync(workflowsPath, "utf8"), kit));

	if (kit === "auth") {
		// The user table and the session table are SQLite files under `.blok/`,
		// which the scaffold ignores wholesale — but a project that decides to
		// track `.blok/` (its `config.json` is a reasonable thing to commit) must
		// not thereby commit password hashes and live session ids
		// (#1018 security review M1).
		ignoreKitDatabases(path.join(projectDir, ".gitignore"));
		// The kit's nodes are npm packages — `discoverNodes()` only finds files
		// under `src/nodes/`, so they are registered explicitly.
		const nodesPath = path.join(projectDir, "src", "Nodes.ts");
		fsExtra.writeFileSync(nodesPath, patchNodesSource(fsExtra.readFileSync(nodesPath, "utf8")));
		// One file per route, IN the project, so they are yours: `blokctl gen
		// app-types` scans this directory (that is where the page contracts and
		// the route table come from), and the HTTP trigger auto-routes each
		// file's default export.
		const authDir = path.join(projectDir, "src", "workflows", "auth");
		fsExtra.ensureDirSync(authDir);
		for (const [file, source] of Object.entries(AUTH_ROUTE_FILES)) {
			fsExtra.writeFileSync(path.join(authDir, file), source);
		}
	} else {
		// `--kit auth` brings the REAL one (`@blokjs/auth`'s currentUser, wired by
		// authKitMiddleware); the placeholder would only shadow it.
		fsExtra.ensureDirSync(path.join(projectDir, "src", "nodes", "current-user"));
		fsExtra.writeFileSync(path.join(projectDir, "src", "nodes", "current-user", "index.ts"), CURRENT_USER_NODE);
	}
	fsExtra.ensureDirSync(path.join(projectDir, "src", "nodes", "home-greeting"));
	fsExtra.writeFileSync(path.join(projectDir, "src", "nodes", "home-greeting", "index.ts"), HOME_GREETING_NODE);
	fsExtra.ensureDirSync(path.join(projectDir, "src", "workflows"));
	fsExtra.writeFileSync(path.join(projectDir, "src", "workflows", "home.ts"), HOME_WORKFLOW);

	if (opts.install !== false) {
		await installIn(projectDir, managerName);
		await installIn(clientDir, managerName);
	}

	console.log(color.green(`\n✅ ${framework} client added at ${CLIENT_DIR}/`));
	if (kit === "auth") {
		console.log(
			`${color.green("   auth kit: ")}register → sign in → /dashboard → sign out, with sessions, CSRF and reset.\n` +
				`   Routes in src/workflows/auth/, pages in ${CLIENT_DIR}/src/pages/Auth/ — both yours to edit.`,
		);
	}
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
 * lookup, or run \`blokctl add spa --kit auth\` to get the real one
 * (\`@blokjs/auth\`), whose output this shape mirrors:
 *
 * - \`id\` is what \`inertia.auth\`'s guest guard tests — ABSENT for a guest;
 * - \`user\` is what the client reads (\`usePage().props.auth.user\`), \`null\`
 *   for a guest so a layout can branch on it without optional chaining.
 */
export default defineNode({
	name: "current-user",
	description: "Resolve the authenticated user for Inertia's shared props.",
	input: z.object({
		headers: z.record(z.string()).optional(),
	}),
	output: z.object({
		id: z.string().optional(),
		user: z
			.object({
				id: z.string(),
				name: z.string(),
				email: z.string(),
			})
			.nullable(),
	}),
	async execute(_ctx, _input) {
		return { user: null };
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
