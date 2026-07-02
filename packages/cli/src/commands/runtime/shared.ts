/**
 * Shared helpers for the `blokctl runtime` command group: locating the
 * project root, resolving a version-matched SDK source, scanning workflows for
 * runtime references, and inspecting user-authored runtime nodes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import color from "picocolors";
import simpleGit, { type SimpleGit } from "simple-git";
import { tryConnect } from "../../services/health-probe.js";
import { getRuntimeDefinition } from "../../services/runtime-detector.js";
import { type ProjectConfig, readProjectConfig } from "../../services/runtime-setup.js";

const HOME_DIR = `${os.homedir()}/.blok`;
const GITHUB_REPO_REMOTE = "https://github.com/well-prado/blok.git";

/** Kinds that can never be added/removed as a sidecar runtime. */
export const NON_SIDECAR_KINDS = new Set(["node", "nodejs", "typescript", "ts", "bun", "docker", "wasm"]);

export class RuntimeCommandError extends Error {}

/**
 * Read `.blok/config.json`, turning a malformed file into a friendly error
 * (the bare `readProjectConfig` throws a raw SyntaxError). Returns `{}` when the
 * project simply has no config yet.
 */
export function readConfigSafe(projectRoot: string): ProjectConfig {
	try {
		return readProjectConfig(projectRoot) ?? {};
	} catch {
		throw new RuntimeCommandError(
			`Could not parse ${path.join(projectRoot, ".blok", "config.json")} — fix or delete it and retry.`,
		);
	}
}

/**
 * Best-effort guard: reject when something is already listening on the target
 * gRPC port (a co-located project, or a stray process). Cheap TCP connect with
 * a short timeout; a refused connection (port free) returns quickly.
 */
export async function assertGrpcPortFree(grpcPort: number): Promise<void> {
	if (await tryConnect("127.0.0.1", grpcPort, 400)) {
		throw new RuntimeCommandError(
			`gRPC port ${grpcPort} is already in use by a live process. Stop it, or pass --grpc-port <n> to use another port.`,
		);
	}
}

/**
 * Resolve + validate the Blok project root. Uses `--directory` when given,
 * otherwise the current directory. A project must have a `package.json`; we
 * also accept the absence of `.blok/config.json` (a project that was created
 * with only `node` has no runtimes block yet) but require it to look like a
 * Blok project (a `@blokjs/*` dependency).
 */
export function resolveProjectRoot(directory?: string): string {
	const root = path.resolve(directory ?? process.cwd());
	const pkgPath = path.join(root, "package.json");
	if (!fs.existsSync(pkgPath)) {
		throw new RuntimeCommandError(
			`No package.json found at ${root}. Run this inside a Blok project, or pass --directory <path>.`,
		);
	}
	let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
	try {
		pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
	} catch {
		throw new RuntimeCommandError(`Could not parse ${pkgPath}.`);
	}
	const deps = { ...pkg.dependencies, ...pkg.devDependencies };
	const looksLikeBlok =
		Object.keys(deps).some((d) => d.startsWith("@blokjs/")) || fs.existsSync(path.join(root, ".blok"));
	if (!looksLikeBlok) {
		throw new RuntimeCommandError(
			`${root} doesn't look like a Blok project (no @blokjs/* dependency, no .blok/). Pass --directory <path> to the project root.`,
		);
	}
	return root;
}

/**
 * Read the project's pinned framework version from its `@blokjs/runner`
 * (falling back to `blokctl`) dependency range, e.g. `^0.6.19` → `v0.6.19`.
 * Returns null when no Blok dep pins a concrete version (e.g. a `workspace:*`
 * or `*` range), in which case the caller should require `--local`.
 */
export function readFrameworkTag(projectRoot: string): string | null {
	const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	const deps = { ...pkg.dependencies, ...pkg.devDependencies };
	const range = deps["@blokjs/runner"] ?? deps["@blokjs/shared"] ?? deps.blokctl;
	if (!range) return null;
	const m = range.match(/(\d+\.\d+\.\d+)/);
	return m ? `v${m[1]}` : null;
}

/**
 * Resolve a repo directory that contains `sdks/<lang>/` source, matched to the
 * project's framework version so the SDK's gRPC proto is compatible.
 *
 * - `localOverride` (from `--local`) wins; validated to contain `sdks/`.
 * - Then the assets bundled into the built package (dist/scaffold-repo) —
 *   version-matched by construction, no network, no repo access needed.
 * - Last resort (running from source without a build): the project's pinned
 *   version tag is cloned (shallow) into a per-version cache under
 *   `~/.blok/sdk-src/<tag>`. A missing/unreleased tag throws with `--local`
 *   guidance.
 */
export async function resolveSdkSource(
	projectRoot: string,
	localOverride: string | undefined,
	onProgress?: (msg: string) => void,
): Promise<string> {
	if (localOverride) {
		const resolved = path.resolve(localOverride);
		if (!fs.existsSync(path.join(resolved, "sdks"))) {
			throw new RuntimeCommandError(`--local path ${resolved} has no sdks/ directory.`);
		}
		return resolved;
	}

	// dist/commands/runtime/shared.js → dist/scaffold-repo (see
	// scripts/bundle-scaffold-assets.ts).
	const bundled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scaffold-repo");
	if (fs.existsSync(path.join(bundled, "sdks"))) return bundled;

	const tag = readFrameworkTag(projectRoot);
	if (!tag) {
		throw new RuntimeCommandError(
			"Couldn't determine the project's Blok version from package.json. Pass --local <path-to-blok-repo> to point at a matching SDK source.",
		);
	}

	const cacheDir = path.join(HOME_DIR, "sdk-src", tag);
	if (fs.existsSync(path.join(cacheDir, "sdks"))) return cacheDir;

	onProgress?.(`Fetching SDK source (blok ${tag})…`);
	fs.mkdirSync(path.join(HOME_DIR, "sdk-src"), { recursive: true });
	const git: SimpleGit = simpleGit({ baseDir: path.join(HOME_DIR, "sdk-src") });
	try {
		await git.clone(GITHUB_REPO_REMOTE, cacheDir, ["--branch", tag, "--depth", "1"]);
	} catch (err) {
		// Clean a partial clone so a retry isn't poisoned.
		fs.rmSync(cacheDir, { recursive: true, force: true });
		throw new RuntimeCommandError(
			`Couldn't fetch the SDK source for ${tag} (${(err as Error).message.split("\n")[0]}). If this version isn't on GitHub, pass --local <path-to-blok-repo>.`,
		);
	}
	if (!fs.existsSync(path.join(cacheDir, "sdks"))) {
		throw new RuntimeCommandError(`Fetched ${tag} but it has no sdks/ directory.`);
	}
	return cacheDir;
}

export interface WorkflowRuntimeHit {
	/** Project-relative path of the workflow file. */
	file: string;
	/** Number of `runtime.<kind>` references in the file. */
	count: number;
}

const SCAN_SKIP_DIRS = new Set(["node_modules", ".blok", "dist", ".git", "coverage", "runtimes", ".nx"]);

/**
 * Recursively scan a project's `.ts` / `.json` source for references to
 * `runtime.<kind>` (the step type that dispatches to this sidecar). Used to
 * warn the author before a remove leaves dangling workflow steps. Heuristic +
 * deliberately over-inclusive — a warning is cheap, a silent break is not.
 */
export function scanWorkflowsForRuntime(projectRoot: string, kind: string): WorkflowRuntimeHit[] {
	const ref = new RegExp(`runtime\\.${kind}\\b`, "g");
	const hits: WorkflowRuntimeHit[] = [];

	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!SCAN_SKIP_DIRS.has(entry.name)) walk(full);
				continue;
			}
			if (!/\.(ts|tsx|js|mjs|json)$/.test(entry.name)) continue;
			let content: string;
			try {
				content = fs.readFileSync(full, "utf8");
			} catch {
				continue;
			}
			const matches = content.match(ref);
			if (matches && matches.length > 0) {
				hits.push({ file: path.relative(projectRoot, full), count: matches.length });
			}
		}
	};

	walk(projectRoot);
	return hits.sort((a, b) => a.file.localeCompare(b.file));
}

export interface UserNodesInfo {
	/** Absolute path to `runtimes/<kind>/nodes`. */
	dir: string;
	/** True when the path is a symlink (python3's SDK junction, not user code). */
	isSymlink: boolean;
	/** Relative paths of real files the user authored (empty for a symlink/missing dir). */
	files: string[];
}

/**
 * Inspect `runtimes/<kind>/nodes/` for user-authored node source. python3
 * symlinks this to the SDK's own nodes (a junction), so a symlink is reported
 * as such and never treated as deletable user code.
 */
export function listUserNodes(projectRoot: string, kind: string): UserNodesInfo {
	const dir = path.join(projectRoot, "runtimes", kind, "nodes");
	if (!fs.existsSync(dir)) return { dir, isSymlink: false, files: [] };
	const stat = fs.lstatSync(dir);
	if (stat.isSymbolicLink()) return { dir, isSymlink: true, files: [] };

	const files: string[] = [];
	const walk = (d: string): void => {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) continue;
			const full = path.join(d, entry.name);
			if (entry.isDirectory()) walk(full);
			else files.push(path.relative(dir, full));
		}
	};
	walk(dir);
	return { dir, isSymlink: false, files: files.sort() };
}

/**
 * Print a friendly terminal message for a failed `runtime` command and set a
 * non-zero exit code. `RuntimeCommandError`s are expected/operational (shown
 * plainly); anything else is an unexpected error (shown as such).
 */
export function reportRuntimeError(err: unknown): void {
	if (err instanceof RuntimeCommandError) {
		p.cancel(err.message);
	} else {
		p.cancel(color.red(`Unexpected error: ${(err as Error)?.message ?? String(err)}`));
	}
	process.exitCode = 1;
}

/** Validate that a kind is an addable/removable sidecar runtime. Throws a friendly error otherwise. */
export function assertSidecarKind(kind: string): void {
	if (NON_SIDECAR_KINDS.has(kind)) {
		throw new RuntimeCommandError(
			`"${kind}" runs in-process and is always available — there's no sidecar to add or remove. Sidecar runtimes: go, rust, java, csharp, php, ruby, python3.`,
		);
	}
	if (!getRuntimeDefinition(kind)) {
		throw new RuntimeCommandError(`Unknown runtime "${kind}". Supported: go, rust, java, csharp, php, ruby, python3.`);
	}
}
