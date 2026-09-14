import { existsSync, promises as fsp } from "node:fs";
import module from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * scanWorkflows — recursive directory scanner that discovers HTTP-triggered
 * workflows on disk and derives a default URL path from each file's location.
 *
 * **Path derivation rules** (file path → URL):
 * ```
 * workflows/health.ts                      → /health
 * workflows/index.ts                       → /
 * workflows/users/list.ts                  → /users/list
 * workflows/users/index.ts                 → /users
 * workflows/users/[id].ts                  → /users/:id
 * workflows/users/[id]/orders.ts           → /users/:id/orders
 * workflows/json/orders/by-status/[s].json → /orders/by-status/:s
 *                                            (the `json/` segment is a format
 *                                             indicator, not a URL segment)
 * ```
 *
 * **Skipped files** (return no scanned entry):
 * - Files or directories whose name starts with `_` or `.`
 *   (utilities, drafts, hidden files)
 * - Files whose extension isn't allowed (only `.ts`, `.js`, `.json` for now)
 *
 * **Workflow detection**:
 * - For TS/JS: dynamic-imports, takes `default` export.
 * - For JSON: `readFile` + `JSON.parse`.
 * - Files that don't yield a recognisable workflow shape are skipped with
 *   a warning (caller decides whether to surface to the operator).
 */

/** A workflow entry produced by the scanner. */
export interface ScannedWorkflow {
	/** Absolute filesystem path. */
	readonly source: string;
	/** Source format. */
	readonly kind: "ts" | "json";
	/** Default URL path derived from the file's location. */
	readonly defaultPath: string;
	/** Parsed workflow object — raw, not normalized. */
	readonly workflow: unknown;
	/** Workflow name extracted from the parsed object (best-effort). */
	readonly name: string | undefined;
}

/** Configuration for one scan root. */
export interface ScanRoot {
	/** Absolute directory to walk recursively. */
	readonly dir: string;
	/**
	 * Number of leading directory segments to strip from the file's
	 * path-relative-to-`dir` before deriving the URL. Used to elide the
	 * format-indicator folder (e.g. `json/` for JSON workflows).
	 */
	readonly stripLeadingSegments?: number;
	/** Allowed extensions. Defaults to `[".ts", ".js"]` for TS, `[".json"]` for JSON. */
	readonly extensions?: readonly string[];
	/** Source kind reported on each entry. */
	readonly kind: "ts" | "json";
}

export interface ScanOptions {
	onLoadError?: (file: string, err: Error) => void;
	/**
	 * Cache-buster appended to a TS/JS dynamic import so an edited workflow
	 * module is re-evaluated instead of served from the ESM module cache. Hot
	 * reload passes a timestamp; boot passes nothing (one cache entry per file).
	 */
	cacheBust?: string;
	/**
	 * Restricts `cacheBust` to specific absolute file paths. Re-evaluating
	 * EVERY workflow on every edit is pure waste: a busted module still
	 * resolves its own imports from cache, so busting the untouched files buys
	 * no extra freshness — it just re-runs the whole corpus per keystroke.
	 * Unset means bust everything (used when the changed file isn't known).
	 */
	cacheBustOnly?: ReadonlySet<string>;
}

/**
 * Walk every root and produce a flat list of scanned workflows.
 *
 * Errors loading individual files are caught and surfaced via the
 * `onLoadError` callback (when supplied). The scanner never throws on
 * a single bad file — boot continues with the rest.
 */
export async function scanWorkflows(roots: readonly ScanRoot[], options: ScanOptions = {}): Promise<ScannedWorkflow[]> {
	const out: ScannedWorkflow[] = [];
	for (const root of roots) {
		const exists = await dirExists(root.dir);
		if (!exists) continue;
		const allowedExts = root.extensions ?? defaultExtensions(root.kind);
		await walk(root.dir, root.dir, root, allowedExts, out, options);
	}
	return out;
}

/**
 * Convert a file path (relative to a scan root) to a URL path.
 *
 * **EXPORTED FOR UNIT TESTING.** Pure function with no I/O.
 *
 * @param relativePath - file path relative to its scan root, with extension
 * @param stripLeadingSegments - number of leading dirs to drop (e.g. `1`
 *   for JSON which lives under `workflows/json/`)
 * @returns derived URL like `/users/:id`, or `/` for root index
 */
export function deriveUrlFromFilePath(relativePath: string, stripLeadingSegments = 0): string {
	const noExt = relativePath.replace(/\.(ts|js|json)$/i, "");
	const segments = noExt.split(path.sep).filter((s) => s.length > 0);
	const stripped = segments.slice(stripLeadingSegments);

	if (stripped.length === 0) return "/";

	// Drop trailing `index` (folder URL convention).
	if (stripped[stripped.length - 1] === "index") stripped.pop();

	if (stripped.length === 0) return "/";

	// Convert [param] → :param on each segment.
	const converted = stripped.map((seg) => {
		const match = seg.match(/^\[(\.{3})?([A-Za-z_][A-Za-z0-9_]*)\]$/);
		if (!match) return seg;
		// `[...slug]` catch-all is reserved for a future iteration.
		// For v1 we only handle `[id]` → `:id`.
		return `:${match[2]}`;
	});

	return `/${converted.join("/")}`;
}

// ---------------------------------------------------------------------------

async function walk(
	rootDir: string,
	currentDir: string,
	root: ScanRoot,
	allowedExts: readonly string[],
	out: ScannedWorkflow[],
	options: ScanOptions,
): Promise<void> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fsp.readdir(currentDir, { withFileTypes: true });
	} catch (err) {
		options.onLoadError?.(currentDir, err as Error);
		return;
	}

	for (const entry of entries) {
		// Skip hidden and convention-private entries.
		if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;

		const fullPath = path.join(currentDir, entry.name);
		if (entry.isDirectory()) {
			await walk(rootDir, fullPath, root, allowedExts, out, options);
			continue;
		}
		if (!entry.isFile()) continue;
		if (!allowedExts.some((ext) => entry.name.endsWith(ext))) continue;

		const relativePath = path.relative(rootDir, fullPath);
		const defaultPath = deriveUrlFromFilePath(relativePath, root.stripLeadingSegments);

		try {
			const bust =
				options.cacheBust && (!options.cacheBustOnly || options.cacheBustOnly.has(fullPath))
					? options.cacheBust
					: undefined;
			const wf = await loadOne(fullPath, root.kind, bust);
			if (wf === null) continue;
			out.push({
				source: fullPath,
				kind: root.kind,
				defaultPath,
				workflow: wf,
				name: extractWorkflowName(wf),
			});
		} catch (err) {
			options.onLoadError?.(fullPath, err as Error);
		}
	}
}

async function loadOne(file: string, kind: "ts" | "json", cacheBust?: string): Promise<unknown> {
	if (kind === "json") {
		const text = await fsp.readFile(file, "utf8");
		return JSON.parse(text);
	}
	// TS / JS — dynamic import; default export is the workflow. A cache-buster
	// needs a proper file: URL to carry the query string, so only the hot-reload
	// path pays the conversion; boot keeps importing the bare path as before.
	enableTsSpecifierResolution();
	const specifier = cacheBust ? `${pathToFileURL(file).href}?blokHmr=${cacheBust}` : file;
	let mod: { default?: unknown };
	try {
		mod = (await import(specifier)) as { default?: unknown };
	} catch (err) {
		throw explainTsSiblingMiss(err);
	}
	if (mod.default === undefined) return null;
	return mod.default;
}

/**
 * `./x.js` → `./x.ts` when only the `.ts` exists — the rewrite `tsc` and
 * bundlers do and Node's type stripping does NOT. Without it a scanned
 * workflow cannot import its own node or a shared helper under
 * `node dist/triggers/http/index.js`: Node resolves the specifier literally,
 * the import throws ERR_MODULE_NOT_FOUND, and the route silently never
 * registers (Bun hides this, so it only surfaces in production).
 *
 * Same hook `blokctl gen` installs (`packages/cli/.../pagesTypes.ts`); the
 * two packages share no runtime module, so it is duplicated rather than
 * exported from @blokjs/core. ponytail: fold both into one export if a third
 * copy ever appears.
 */
function tsFallbackUrl(specifier: string, parentURL: string | undefined): string | undefined {
	if (parentURL === undefined || !/^\.{1,2}\//.test(specifier)) return undefined;
	let target: URL;
	try {
		target = new URL(specifier, parentURL);
	} catch {
		return undefined;
	}
	if (target.protocol !== "file:") return undefined;
	const asPath = fileURLToPath(target);
	if (existsSync(asPath)) return undefined;
	const candidate = asPath.endsWith(".js") ? `${asPath.slice(0, -3)}.ts` : `${asPath}.ts`;
	return existsSync(candidate) ? pathToFileURL(candidate).href : undefined;
}

let hooksRegistered = false;

/**
 * `module.registerHooks()` is Node >= 22.15 and synchronous, so it applies to
 * the very next `import()`. Bun and older Node lack it: Bun already resolves
 * `.js` → `.ts` itself, and a Node without it gets the explanation from
 * `explainTsSiblingMiss` instead.
 */
function enableTsSpecifierResolution(): void {
	if (hooksRegistered) return;
	hooksRegistered = true;
	const registerHooks = (module as { registerHooks?: (hooks: Record<string, unknown>) => void }).registerHooks;
	if (typeof registerHooks !== "function") return;
	registerHooks({
		resolve(
			specifier: string,
			context: { parentURL?: string },
			nextResolve: (s: string, c: { parentURL?: string }) => unknown,
		) {
			const fallback = tsFallbackUrl(specifier, context.parentURL);
			return fallback === undefined ? nextResolve(specifier, context) : { url: fallback, shortCircuit: true };
		},
	});
}

/**
 * ERR_MODULE_NOT_FOUND on a `.js` specifier whose `.ts` sibling exists is the
 * one import failure worth translating: the raw message names a file the
 * user never wrote, and the route it dropped 404s with no other trace.
 */
function explainTsSiblingMiss(err: unknown): unknown {
	if (!(err instanceof Error) || (err as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") return err;
	const missing = /Cannot find module '([^']+\.js)'/.exec(err.message)?.[1];
	if (!missing || !existsSync(`${missing.slice(0, -3)}.ts`)) return err;
	err.message +=
		" — the .ts sibling exists but this Node cannot rewrite the .js specifier to it (module.registerHooks needs Node >= 22.15). Upgrade Node, or run under Bun.";
	return err;
}

function defaultExtensions(kind: "ts" | "json"): readonly string[] {
	if (kind === "json") return [".json"];
	return [".ts", ".js"];
}

async function dirExists(dir: string): Promise<boolean> {
	try {
		const stat = await fsp.stat(dir);
		return stat.isDirectory();
	} catch {
		return false;
	}
}

function extractWorkflowName(wf: unknown): string | undefined {
	if (!wf || typeof wf !== "object") return undefined;
	const obj = wf as Record<string, unknown>;
	if (typeof obj.name === "string") return obj.name;
	const config = obj._config;
	if (config && typeof config === "object" && typeof (config as Record<string, unknown>).name === "string") {
		return (config as Record<string, unknown>).name as string;
	}
	return undefined;
}
