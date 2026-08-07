import { type FSWatcher, statSync, watch } from "node:fs";
import path from "node:path";
import { type ChangeAction, classifyChange } from "@blokjs/runner";

/**
 * The restart half of `blokctl dev`'s watcher.
 *
 * `blokctl dev` used to run every trigger under `bun --watch`, which restarted
 * the whole process on ANY source change — including the workflow and node
 * edits the in-process hot reloader was already set up to absorb. HMR never got
 * a chance to run, and users paid a full restart for a one-line change.
 *
 * This watcher owns ONLY what HMR legitimately cannot absorb:
 *
 * | Watched                        | Action  |
 * |--------------------------------|---------|
 * | `src/triggers/**`, entrypoints | restart |
 * | `.env`, `.env.*`               | restart |
 * | `.blok/config.json`            | restart |
 * | `runtimes/<lang>/**`           | regen   |
 *
 * `workflows/**` and `nodes/**` are deliberately NOT watched here — the running
 * process hot-reloads them itself. The hot/restart split is decided by
 * `classifyChange` in `@blokjs/runner`, the same function the in-process
 * watcher uses, so the two halves can't drift apart.
 */

export interface DevWatchOptions {
	/** Project root. `.env*` and `.blok/config.json` are watched here. */
	readonly root: string;
	/** Absolute dirs holding trigger entrypoints. */
	readonly triggerPaths: readonly string[];
	/** Absolute dirs holding polyglot sidecar node sources. */
	readonly runtimePaths: readonly string[];
	/** Called for a restart-class change. */
	readonly onRestart: (file: string, reason: string) => void;
	/** Called for a stub-regen-class change. */
	readonly onRegen: (file: string, reason: string) => void;
	/** Coalescing window. Editors write a file several times per save. */
	readonly debounceMs?: number;
}

export interface DevWatcher {
	stop(): void;
}

/** Decide what a path does, with the project's roots already applied. */
export function classifyDevChange(
	file: string,
	opts: Pick<DevWatchOptions, "triggerPaths" | "runtimePaths">,
): { action: ChangeAction; reason: string } {
	return classifyChange(file, {
		triggerPaths: opts.triggerPaths,
		runtimePaths: opts.runtimePaths,
	});
}

/**
 * Start watching. Returns a handle whose `stop()` closes every watcher.
 *
 * ponytail: `fs.watch` with a debounce, no chokidar. Recursive `fs.watch` is
 * native on macOS and Windows and has been supported on Linux since Node 20 —
 * the engines floor. Upgrade path if a platform regresses: swap the body for a
 * polling watcher, the callback contract stays the same.
 */
export function startDevWatcher(opts: DevWatchOptions): DevWatcher {
	const debounceMs = opts.debounceMs ?? 200;
	const watchers: FSWatcher[] = [];
	const timers = new Map<string, NodeJS.Timeout>();
	let stopped = false;

	const dispatch = (file: string): void => {
		if (stopped) return;
		// Only real files. macOS FSEvents emits directory-level and phantom
		// entries for a recursive watch, which would otherwise restart the whole
		// stack because a sibling directory was touched.
		//
		// ponytail: this also means DELETING `.env` doesn't restart (only editing
		// it does) — an edit is the flow that matters and the alternative is
		// tracking every watched path's prior stat. Add that bookkeeping if
		// delete-to-restart ever comes up.
		if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return;
		const { action, reason } = classifyDevChange(file, opts);
		if (action !== "restart" && action !== "regen") return;

		const existing = timers.get(file);
		if (existing) clearTimeout(existing);
		timers.set(
			file,
			setTimeout(() => {
				timers.delete(file);
				if (stopped) return;
				if (action === "restart") opts.onRestart(file, reason);
				else opts.onRegen(file, reason);
			}, debounceMs),
		);
	};

	const addWatcher = (target: string, recursive: boolean): void => {
		try {
			// `triggerPaths` may name a single entrypoint file (`src/index.ts`)
			// rather than a directory. Watching a file reports its own basename,
			// so joining would produce `src/index.ts/index.ts` — dispatch the
			// path itself instead.
			const isFile = statSync(target, { throwIfNoEntry: false })?.isFile() === true;
			const w = watch(target, { recursive: recursive && !isFile }, (_event, filename) => {
				if (isFile) return dispatch(target);
				if (!filename) return;
				dispatch(path.join(target, filename.toString()));
			});
			// A watcher error (dir removed mid-session) must never kill the dev
			// loop — the rest of the watchers keep working.
			w.on("error", () => {});
			watchers.push(w);
		} catch {
			// Directory doesn't exist yet — nothing to watch, not an error.
		}
	};

	// Project root, non-recursive: `.env*` lives here, and a recursive watch of
	// the root would re-watch node_modules and every workflow directory.
	addWatcher(opts.root, false);
	addWatcher(path.join(opts.root, ".blok"), false);
	for (const dir of opts.triggerPaths) addWatcher(dir, true);
	for (const dir of opts.runtimePaths) addWatcher(dir, true);

	return {
		stop() {
			stopped = true;
			for (const t of timers.values()) clearTimeout(t);
			timers.clear();
			for (const w of watchers) {
				try {
					w.close();
				} catch {
					// already closed
				}
			}
			watchers.length = 0;
		},
	};
}
