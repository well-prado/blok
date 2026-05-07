import { promises as fsp } from "node:fs";
import * as path from "node:path";

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

/**
 * Walk every root and produce a flat list of scanned workflows.
 *
 * Errors loading individual files are caught and surfaced via the
 * `onLoadError` callback (when supplied). The scanner never throws on
 * a single bad file — boot continues with the rest.
 */
export async function scanWorkflows(
	roots: readonly ScanRoot[],
	options: { onLoadError?: (file: string, err: Error) => void } = {},
): Promise<ScannedWorkflow[]> {
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
	options: { onLoadError?: (file: string, err: Error) => void },
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
			const wf = await loadOne(fullPath, root.kind);
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

async function loadOne(file: string, kind: "ts" | "json"): Promise<unknown> {
	if (kind === "json") {
		const text = await fsp.readFile(file, "utf8");
		return JSON.parse(text);
	}
	// TS / JS — dynamic import; default export is the workflow.
	const mod = (await import(file)) as { default?: unknown };
	if (mod.default === undefined) return null;
	return mod.default;
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
