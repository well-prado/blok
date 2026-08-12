/**
 * The dev-loop contract: ONE function that decides what a changed file does.
 *
 * Two watchers consume it and they must never disagree:
 *   - the in-process {@link HotReloadManager} (owns `workflows/**` + `nodes/**`)
 *   - `blokctl dev`'s restart watcher (owns entrypoints / config / `.env*`)
 *
 * Before this existed the CLI ran the app under `bun --watch`, which restarted
 * the whole process on ANY source change and preempted in-process HMR entirely
 * — users paid full-restart latency and the HMR path never actually ran.
 *
 * The table in `docs/d/cli/dev.mdx` is generated from the same rules and
 * asserted row-by-row in `__tests__/hmr/classifyChange.test.ts`.
 */

/** What the dev loop does with a changed path. */
export type ChangeAction = "hot" | "restart" | "regen" | "ignore";

export interface ChangeClassification {
	readonly action: ChangeAction;
	/** Stable machine-readable reason, also printed to the dev console. */
	readonly reason: string;
}

/** Roots used to classify a path. All absolute, all optional. */
export interface ClassifyRoots {
	/** Directories whose files are workflows (hot). */
	readonly workflowPaths?: readonly string[];
	/** Directories whose files are nodes (hot). */
	readonly nodePaths?: readonly string[];
	/** Directories holding trigger entrypoints / boot code (restart). */
	readonly triggerPaths?: readonly string[];
	/** Directories holding polyglot sidecar node sources (regen stubs). */
	readonly runtimePaths?: readonly string[];
}

const HOT_EXTENSIONS = [".ts", ".js", ".mjs", ".json"];

/**
 * Paths that never reach either watcher — build output, VCS, deps, editor turds.
 *
 * `/target/`, `/.venv/` and `/__pycache__/` are the sidecar-runtime equivalents
 * of `/dist/`: they live UNDER a `runtimePaths` root, so without them one
 * `cargo build` classifies hundreds of artifacts as `regen` and each one fetches
 * the node catalog from the dev server — enough to stop it serving, which takes
 * in-flight requests down with it.
 */
const IGNORED_SEGMENTS = [
	"/node_modules/",
	"/dist/",
	"/.git/",
	"/coverage/",
	"/.nx/",
	"/target/",
	"/.venv/",
	"/__pycache__/",
];

function isUnder(file: string, dir: string): boolean {
	if (dir.length === 0) return false;
	const normalized = dir.endsWith("/") ? dir : `${dir}/`;
	return file === dir || file.startsWith(normalized);
}

function basename(file: string): string {
	const i = file.lastIndexOf("/");
	return i === -1 ? file : file.slice(i + 1);
}

function hasHotExtension(file: string): boolean {
	return HOT_EXTENSIONS.some((ext) => file.endsWith(ext));
}

/**
 * Classify an absolute path against the project's roots.
 *
 * Precedence matters: an ignored path wins over everything (so a
 * `workflows/dist/x.js` build artifact never triggers a reload), then the
 * restart class (`.env*`, config, generated stubs, trigger entrypoints),
 * then the hot class. Anything else is ignored — the dev loop stays quiet
 * for README edits and test files.
 */
export function classifyChange(filePath: string, roots: ClassifyRoots = {}): ChangeClassification {
	const file = filePath.replaceAll("\\", "/");
	const name = basename(file);

	if (IGNORED_SEGMENTS.some((seg) => file.includes(seg))) {
		return { action: "ignore", reason: "build output or dependency" };
	}
	if (name.endsWith(".d.ts")) {
		return { action: "ignore", reason: "type declaration" };
	}
	if (file.includes("/__tests__/") || /\.(test|spec)\.[cm]?[jt]s$/.test(name)) {
		return { action: "ignore", reason: "test file" };
	}

	// --- restart class: state HMR cannot re-derive in-process ---
	if (name === ".env" || name.startsWith(".env.")) {
		return { action: "restart", reason: "environment file — process env is read at boot" };
	}
	if (file.includes("/.blok/") && name === "config.json") {
		return { action: "restart", reason: "project config — trigger/runtime topology changed" };
	}
	// Generated output. Deliberately NOT restart-class: the watcher itself
	// rewrites these (stub regen), so restarting on them would be a loop.
	if (file.includes("/.blok/runtimes/") || file.includes("/nodes-gen/")) {
		return { action: "ignore", reason: "generated stub — rewritten by the watcher" };
	}
	for (const dir of roots.runtimePaths ?? []) {
		if (isUnder(file, dir.replaceAll("\\", "/"))) {
			return { action: "regen", reason: "sidecar node source — runtime stubs regenerated" };
		}
	}
	for (const dir of roots.triggerPaths ?? []) {
		if (isUnder(file, dir.replaceAll("\\", "/")) && hasHotExtension(file)) {
			return { action: "restart", reason: "trigger entrypoint — the server is constructed here" };
		}
	}

	// --- hot class: the runner can swap these without dropping the process ---
	for (const dir of roots.nodePaths ?? []) {
		if (isUnder(file, dir.replaceAll("\\", "/")) && hasHotExtension(file)) {
			return { action: "hot", reason: "node source — re-imported and re-registered" };
		}
	}
	for (const dir of roots.workflowPaths ?? []) {
		if (isUnder(file, dir.replaceAll("\\", "/")) && hasHotExtension(file)) {
			return { action: "hot", reason: "workflow source — route table re-scanned" };
		}
	}

	return { action: "ignore", reason: "outside the watched roots" };
}
