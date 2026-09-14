/**
 * `blokctl inertia doctor` — the pre-flight for a Blok SPA (#1019).
 *
 * Every failure this catches is one that otherwise shows up as a blank screen,
 * a 500 on the one route nobody clicked, or a form that silently loses its
 * flash message. They are all cheap to check and expensive to debug, and an
 * agent can neither see a blank screen nor read an environment.
 *
 * Every failing check prints a `Fix:` line in the same phrasing the docs and
 * the runtime errors use — `ensurePagesExist` set that convention and #1019
 * made it a rule (`tests/docs/inertia-fix-lines.test.ts`).
 *
 * The command THROWS on failure; `withErrorBoundary` turns that into a
 * non-zero exit (see services/commander.ts — no command calls process.exit).
 */

import { existsSync, promises as fsp } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectTsFiles } from "../gen/appTypes.js";
import {
	type PagesScan,
	enableTsSpecifierResolution,
	findProjectRoot,
	projectHasInertia,
	scanInertiaProject,
} from "../gen/pagesTypes.js";
import { checkSsr } from "./ssr.js";

/** One check's verdict. `skip` means "not applicable here", never "unknown". */
export interface DoctorCheck {
	name: string;
	status: "ok" | "fail" | "skip";
	detail: string;
	/** Present exactly when `status` is `"fail"`. Always starts with `Fix:`. */
	fix?: string;
}

export interface DoctorOptions {
	/** Project directory. Default `process.cwd()`. */
	cwd?: string;
	/** Directory holding the workflow modules, relative to `cwd`. Default `src`. */
	dir?: string;
	/** Environment to check. Default `process.env` — injectable so tests need no mutation. */
	env?: NodeJS.ProcessEnv;
	log?: (line: string) => void;
}

const FALSY = new Set(["0", "false", "off", "no"]);

function ok(name: string, detail: string): DoctorCheck {
	return { name, status: "ok", detail };
}
function fail(name: string, detail: string, fix: string): DoctorCheck {
	return { name, status: "fail", detail, fix };
}
function skip(name: string, detail: string): DoctorCheck {
	return { name, status: "skip", detail };
}

/** The client build directory, the same way the adapter and the trigger resolve it. */
function staticDir(cwd: string, env: NodeJS.ProcessEnv): string {
	const dir = env.BLOK_STATIC_DIR ?? "client/dist";
	return path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
}

async function dependencyNames(projectRoot: string): Promise<Set<string>> {
	try {
		const pkg = JSON.parse(await fsp.readFile(path.join(projectRoot, "package.json"), "utf8")) as Record<
			string,
			Record<string, string> | undefined
		>;
		return new Set(
			["dependencies", "devDependencies", "peerDependencies"].flatMap((field) => Object.keys(pkg[field] ?? {})),
		);
	} catch {
		return new Set();
	}
}

// =============================================================================
// Checks
// =============================================================================

/**
 * Secrets. `BLOK_FLASH_SECRET` is unconditional — flash, error bags and the
 * CSRF bounce-back all ride the signed one-shot cookie and there is no default.
 * `BLOK_SESSION_SECRET` only matters once `@blokjs/session` is installed.
 */
function checkSecrets(env: NodeJS.ProcessEnv, deps: Set<string>): DoctorCheck[] {
	const checks: DoctorCheck[] = [];
	checks.push(
		env.BLOK_FLASH_SECRET
			? ok("BLOK_FLASH_SECRET", "set")
			: fail(
					"BLOK_FLASH_SECRET",
					"not set — flash, error bags and the CSRF bounce-back all sign the one-shot cookie with it, and there is no default.",
					'Fix: set BLOK_FLASH_SECRET, e.g. BLOK_FLASH_SECRET="$(openssl rand -hex 32)".',
				),
	);
	if (!deps.has("@blokjs/session")) {
		checks.push(skip("BLOK_SESSION_SECRET", "@blokjs/session is not installed."));
	} else {
		checks.push(
			env.BLOK_SESSION_SECRET
				? ok("BLOK_SESSION_SECRET", "set")
				: fail(
						"BLOK_SESSION_SECRET",
						"not set — @blokjs/session signs the session cookie (and @blokjs/auth's reset tokens) with it.",
						'Fix: set BLOK_SESSION_SECRET, e.g. BLOK_SESSION_SECRET="$(openssl rand -base64 32)".',
					),
		);
	}
	return checks;
}

/**
 * The asset version the 409 reload path depends on. Either `ASSET_VERSION` is
 * set explicitly, or the Blok Vite plugin has written `.blok-asset-version`
 * into the client build directory at least once.
 */
function checkAssetVersion(cwd: string, env: NodeJS.ProcessEnv): DoctorCheck {
	if (env.ASSET_VERSION) return ok("ASSET_VERSION", "set explicitly.");
	const dir = staticDir(cwd, env);
	const file = path.join(dir, ".blok-asset-version");
	if (existsSync(file)) return ok("ASSET_VERSION", `read from ${file}.`);
	return fail(
		"ASSET_VERSION",
		`not set, and no .blok-asset-version in ${dir} — asset-version mismatches will not force a hard reload.`,
		"Fix: build the client once (the blokInertia() Vite plugin writes .blok-asset-version into its outDir), or set ASSET_VERSION explicitly.",
	);
}

/** Custom shells must carry both markers — `renderShell` only enforces the first. */
function checkShell(scan: PagesScan): DoctorCheck {
	if (scan.shells.length === 0) return ok("shell markers", "every page uses the built-in shell.");
	const broken = scan.shells.filter(
		(entry) => !entry.shell.includes("<!--blok:app-->") || !entry.shell.includes("<!--blok:head-->"),
	);
	if (broken.length === 0) return ok("shell markers", `${scan.shells.length} custom shell(s) carry both markers.`);
	return fail(
		"shell markers",
		`custom shell(s) missing a marker: ${broken.map((entry) => entry.component).join(", ")}.`,
		"Fix: the shell must contain <!--blok:app--> where the app mounts and <!--blok:head--> where <Head> tags go.",
	);
}

/** `inertia.csrf` has to be REGISTERED, not merely installed. */
async function checkCsrf(projectRoot: string, dir: string): Promise<DoctorCheck> {
	const candidates = [path.join(dir, "Workflows.ts"), path.join(projectRoot, "src/Workflows.ts")];
	const file = candidates.find((candidate) => existsSync(candidate));
	if (!file) {
		return fail(
			"inertia.csrf",
			"no Workflows.ts found, so no middleware registry could be read.",
			'Fix: register the middleware in src/Workflows.ts — `"inertia.csrf": await createCsrfMiddleware()` — and add it to setGlobalMiddleware(["inertia.csrf"]).',
		);
	}
	let registered = false;
	try {
		enableTsSpecifierResolution();
		const mod = (await import(`${pathToFileURL(file).href}?blok-doctor=${Date.now()}`)) as { default?: unknown };
		const exported = (await mod.default) as Record<string, unknown> | undefined;
		registered = exported !== null && typeof exported === "object" && Object.hasOwn(exported, "inertia.csrf");
	} catch (err) {
		return fail(
			"inertia.csrf",
			`${path.relative(projectRoot, file)} could not be imported: ${err instanceof Error ? err.message : String(err)}`,
			"Fix: make src/Workflows.ts importable (run `blokctl gen app-types` to see the same failure in isolation), then re-run doctor.",
		);
	}
	return registered
		? ok("inertia.csrf", `registered in ${path.relative(projectRoot, file)}.`)
		: fail(
				"inertia.csrf",
				`${path.relative(projectRoot, file)} does not register "inertia.csrf" — POSTs are unprotected.`,
				'Fix: add `"inertia.csrf": await createCsrfMiddleware()` to the Workflows.ts default export, then WorkflowRegistry.getInstance().setGlobalMiddleware(["inertia.csrf"]).',
			);
}

/** SSR is checked only when it is turned on AND pointed somewhere. */
async function checkSsrHealth(cwd: string, env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
	if (FALSY.has((env.BLOK_INERTIA_SSR_ENABLED ?? "").trim().toLowerCase())) {
		return skip("SSR", "disabled by BLOK_INERTIA_SSR_ENABLED.");
	}
	const configured =
		Boolean(env.BLOK_SSR_URL?.trim()) ||
		Boolean(env.BLOK_INERTIA_SSR_BUNDLE?.trim()) ||
		existsSync(path.join(staticDir(cwd, env), ".blok-ssr-url"));
	if (!configured) return skip("SSR", "not configured (no BLOK_SSR_URL and no .blok-ssr-url).");

	return (await checkSsr(cwd))
		? ok("SSR", "the SSR server answers /health.")
		: fail(
				"SSR",
				"SSR is configured but the server does not answer /health.",
				"Fix: start it with `blokctl inertia start-ssr`, or turn SSR off with BLOK_INERTIA_SSR_ENABLED=false.",
			);
}

// =============================================================================
// The run
// =============================================================================

/**
 * Run every check and return the verdicts. Never throws — the command half
 * decides the exit status.
 */
export async function inertiaDoctor(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const dir = path.resolve(cwd, options.dir ?? "src");
	const projectRoot = await findProjectRoot(cwd);
	const deps = await dependencyNames(projectRoot);

	if (!(await projectHasInertia(projectRoot))) {
		return [
			fail(
				"@blokjs/inertia",
				`${projectRoot} does not declare @blokjs/inertia.`,
				"Fix: run `blokctl add spa` in a Blok project, or install @blokjs/inertia and @blokjs/inertia-client.",
			),
		];
	}

	const checks: DoctorCheck[] = [];
	const files = await collectTsFiles(existsSync(dir) ? dir : cwd);
	const scan = await scanInertiaProject(files, projectRoot);

	if (!scan) {
		checks.push(
			fail(
				"@blokjs/inertia",
				"declared in package.json but not resolvable from this project.",
				"Fix: run your installer (`bun install` / `npm install`), then re-run doctor.",
			),
		);
		return [...checks, ...checkSecrets(env, deps)];
	}

	checks.push(ok("pages", `${scan.pages.length} page(s), ${scan.routes.length} route(s) declared.`));
	if (scan.failures.length > 0) {
		checks.push(
			fail(
				"workflow modules",
				scan.failures.map((failure) => `${path.relative(projectRoot, failure.file)}: ${failure.message}`).join("; "),
				"Fix: make every workflow module importable — a module that throws at import declares no page at all.",
			),
		);
	}

	checks.push(checkShell(scan));
	checks.push(await ensurePagesCheck(projectRoot, cwd, env));
	checks.push(...checkSecrets(env, deps));
	checks.push(checkAssetVersion(cwd, env));
	checks.push(await checkCsrf(projectRoot, dir));
	checks.push(await checkSsrHealth(cwd, env));
	return checks;
}

/**
 * Run the adapter's OWN `ensurePagesExist()`, so the doctor and the boot check
 * can never disagree — including its error text, which already names the fix.
 */
async function ensurePagesCheck(projectRoot: string, cwd: string, env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
	let warning = "";
	try {
		const entry = createRequire(path.join(projectRoot, "package.json")).resolve("@blokjs/inertia");
		const mod = (await import(pathToFileURL(entry).href)) as {
			ensurePagesExist?: (opts: Record<string, unknown>) => Promise<void>;
		};
		if (typeof mod.ensurePagesExist !== "function") return skip("ensurePagesExist", "not exported by this adapter.");
		await mod.ensurePagesExist({
			enabled: true,
			dir: staticDir(cwd, env),
			warn: (message: string) => {
				warning = message;
			},
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// The adapter's own message already ends in a `Fix:` line — carry it
		// through verbatim rather than inventing a second wording.
		const at = message.indexOf("Fix:");
		return fail(
			"ensurePagesExist",
			at === -1 ? message : message.slice(0, at).trim(),
			at === -1
				? "Fix: create the missing page component(s), or correct the component name."
				: message.slice(at).trim(),
		);
	}
	return warning === ""
		? ok("ensurePagesExist", "every declared component exists in the client pages directory.")
		: fail(
				"ensurePagesExist",
				"no page manifest, so no component names were checked.",
				`Fix:${warning.split("Fix:")[1] ?? " build the client once so the Blok Vite plugin writes pages.json."}`.trim(),
			);
}

/** Print the report and THROW when anything failed. */
export async function runDoctor(options: DoctorOptions = {}): Promise<void> {
	const log = options.log ?? ((line: string) => console.log(line));
	const checks = await inertiaDoctor(options);
	const icons = { ok: "✅", fail: "❌", skip: "➖" } as const;

	log("blokctl inertia doctor\n");
	for (const check of checks) {
		log(`${icons[check.status]} ${check.name} — ${check.detail}`);
		if (check.fix) log(`   ${check.fix}`);
	}

	const failures = checks.filter((check) => check.status === "fail");
	if (failures.length === 0) {
		log(`\n${checks.filter((c) => c.status === "ok").length} check(s) passed.`);
		return;
	}
	throw new Error(
		`${failures.length} check(s) failed.\n${failures.map((failure) => `  ${failure.name}: ${failure.fix}`).join("\n")}`,
	);
}
