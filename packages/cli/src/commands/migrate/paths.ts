import { promises as fsp } from "node:fs";
import path from "node:path";
import type { OptionValues } from "commander";
import color from "picocolors";

/**
 * Migrate JSON HTTP workflows to explicit `trigger.http.path` URLs.
 *
 * v0.4 introduces explicit-path-only routing — the filename-derived
 * URL fallback is deprecated. This codemod walks the JSON workflows
 * directory and writes the file-derived URL into each workflow's
 * `trigger.http.path` so users have an explicit declaration before
 * the schema flip lands.
 *
 * Conversion rules:
 * - `trigger.http.path` is missing: write the file-derived URL
 *   (e.g. `triggers/http/workflows/json/users/list.json` → `/users/list`).
 * - `trigger.http.path` is `"/"` AND the file is NOT at the json/ root
 *   (i.e. would collide with sibling root-level workflows): write the
 *   file-derived URL.
 * - `trigger.http.path` is anything else (already explicit): skip.
 *   Idempotent — re-running the codemod on a fully-migrated repo is
 *   a no-op.
 *
 * Folder/segment derivation matches the runner's `deriveUrlFromFilePath`:
 * - `users/[id].json` → `/users/:id`
 * - `users/index.json` → `/users`
 * - Files under `workflows/json/` strip the leading `json` segment.
 *
 * **TS workflows are NOT migrated** — they require AST rewriting.
 * The codemod prints a notice listing any TS workflow files it found
 * with no explicit `path`. Migrate those manually.
 *
 * Each migrated file gets a `<name>.json.bak` backup unless
 * `--no-backup`. Use `--dry-run` to preview without writing.
 */
export async function migratePaths(opts: OptionValues): Promise<void> {
	const cwd = process.cwd();
	const explicitDir = (opts.dir as string | undefined) ?? null;
	const dryRun = opts.dryRun === true;
	const writeBackup = opts.backup !== false; // default true unless --no-backup

	console.log(color.cyan("\n🛣  Workflow path migrator"));
	console.log(color.dim("Adds explicit `trigger.http.path` to every JSON HTTP workflow.\n"));

	const root = await resolveJsonRoot(cwd, explicitDir);
	if (!root) {
		console.log(
			color.red(
				"❌ Could not find a JSON workflows directory. Looked in: " +
					"workflows/json/, triggers/http/workflows/json/. Pass --dir <path> to override.",
			),
		);
		process.exit(1);
	}

	console.log(color.dim(`Scanning ${color.cyan(root)} (recursive)\n`));

	const files = await collectJsonFiles(root);
	if (files.length === 0) {
		console.log(color.yellow("No JSON workflow files found."));
		return;
	}

	const results: PathResult[] = [];
	for (const file of files) {
		const result = await migrateOne(file, root, { dryRun, writeBackup });
		results.push(result);
		printResult(result);
	}

	console.log("");
	printSummary(results, dryRun, writeBackup);

	// Surface TS workflows that may need manual migration.
	const tsRoots = [path.join(cwd, "triggers", "http", "src", "workflows"), path.join(cwd, "src", "workflows")];
	for (const tsRoot of tsRoots) {
		if (await dirExists(tsRoot)) {
			const tsFiles = await collectTsFiles(tsRoot);
			if (tsFiles.length > 0) {
				console.log("");
				console.log(color.yellow("⚠ TS workflows detected — these are NOT migrated by this codemod."));
				console.log(color.dim(`  Found at: ${tsRoot}`));
				console.log(
					color.dim("  Migrate them manually: ensure each workflow's `trigger.http.path` is set explicitly."),
				);
				console.log(color.dim(`  Files: ${tsFiles.length}`));
			}
		}
	}
}

// =============================================================================
// Internals
// =============================================================================

interface PathOpts {
	readonly dryRun: boolean;
	readonly writeBackup: boolean;
}

type PathResult =
	| { kind: "added"; file: string; path: string }
	| { kind: "rewrote-root"; file: string; from: string; to: string }
	| { kind: "already-explicit"; file: string; path: string }
	| { kind: "not-http"; file: string }
	| { kind: "no-trigger"; file: string }
	| { kind: "error"; file: string; error: string };

async function migrateOne(file: string, root: string, opts: PathOpts): Promise<PathResult> {
	let raw: string;
	let parsed: unknown;
	try {
		raw = await fsp.readFile(file, "utf8");
		parsed = JSON.parse(raw);
	} catch (err) {
		return { kind: "error", file, error: (err as Error).message };
	}

	if (!isPlainObject(parsed)) {
		return { kind: "error", file, error: "Workflow must be a JSON object" };
	}

	const wf = parsed as Record<string, unknown>;
	const trigger = wf.trigger;
	if (!isPlainObject(trigger)) {
		return { kind: "no-trigger", file };
	}

	const httpCfg = (trigger as Record<string, unknown>).http;
	if (!isPlainObject(httpCfg)) {
		return { kind: "not-http", file };
	}

	const http = httpCfg as Record<string, unknown>;
	const existingPath = typeof http.path === "string" ? http.path : undefined;

	// Compute the file-derived URL (same logic as the runner's
	// deriveUrlFromFilePath). The relative path is from the scan root,
	// not the workflow file's own dirname — and the json/ scan root is
	// already inside `triggers/http/workflows/`, so no segments to strip.
	const relative = path.relative(root, file);
	const derivedUrl = deriveUrlFromFilePath(relative);

	// Decide what to do:
	// - No path → write derivedUrl
	// - path === "/" AND derived !== "/" → rewrite to derived
	//   (covers the common collision case where every legacy workflow
	//   declares `path: "/"` and depends on the catch-all dispatch
	//   prefixing the workflow key)
	// - path === derivedUrl → already done, idempotent
	// - any other explicit path → leave alone (author chose it)
	if (existingPath === undefined) {
		http.path = derivedUrl;
	} else if (existingPath === "/" && derivedUrl !== "/") {
		http.path = derivedUrl;
		const serialized = `${JSON.stringify(wf, null, "\t")}\n`;
		if (serialized.trimEnd() === raw.trimEnd()) {
			return { kind: "already-explicit", file, path: derivedUrl };
		}
		const writeResult = await maybeWrite(file, raw, serialized, opts);
		if (writeResult) return writeResult;
		return { kind: "rewrote-root", file, from: "/", to: derivedUrl };
	} else {
		return { kind: "already-explicit", file, path: existingPath };
	}

	const serialized = `${JSON.stringify(wf, null, "\t")}\n`;
	if (serialized.trimEnd() === raw.trimEnd()) {
		return { kind: "already-explicit", file, path: existingPath ?? derivedUrl };
	}

	const writeResult = await maybeWrite(file, raw, serialized, opts);
	if (writeResult) return writeResult;
	return { kind: "added", file, path: http.path as string };
}

async function maybeWrite(file: string, raw: string, serialized: string, opts: PathOpts): Promise<PathResult | null> {
	if (opts.dryRun) return null;
	if (opts.writeBackup) {
		try {
			await fsp.writeFile(`${file}.bak`, raw);
		} catch (err) {
			return { kind: "error", file, error: `Failed to write backup: ${(err as Error).message}` };
		}
	}
	try {
		await fsp.writeFile(file, serialized);
	} catch (err) {
		return { kind: "error", file, error: (err as Error).message };
	}
	return null;
}

/**
 * Mirror of the runner's `deriveUrlFromFilePath`. Pure function — no
 * I/O. Kept inline so the CLI doesn't have to import the trigger
 * package.
 */
function deriveUrlFromFilePath(relativePath: string): string {
	const noExt = relativePath.replace(/\.json$/i, "");
	const segments = noExt.split(path.sep).filter((s) => s.length > 0);

	if (segments.length === 0) return "/";

	// Drop trailing `index` (folder URL convention).
	if (segments[segments.length - 1] === "index") segments.pop();

	if (segments.length === 0) return "/";

	// Convert [param] → :param on each segment.
	const converted = segments.map((seg) => {
		const match = seg.match(/^\[(\.{3})?([A-Za-z_][A-Za-z0-9_]*)\]$/);
		if (!match) return seg;
		return `:${match[2]}`;
	});

	return `/${converted.join("/")}`;
}

function printResult(result: PathResult): void {
	const rel = path.relative(process.cwd(), result.file);
	switch (result.kind) {
		case "added":
			console.log(`  ${color.green("✓")} ${rel} ${color.dim("→")} ${color.cyan(`path: "${result.path}"`)}`);
			break;
		case "rewrote-root":
			console.log(
				`  ${color.green("✓")} ${rel} ${color.dim("→")} ${color.cyan(`"${result.from}"`)} → ${color.cyan(`"${result.to}"`)}`,
			);
			break;
		case "already-explicit":
			console.log(`  ${color.dim("·")} ${rel} ${color.dim(`(already explicit: "${result.path}")`)}`);
			break;
		case "no-trigger":
			console.log(`  ${color.dim("·")} ${rel} ${color.dim("(no trigger)")}`);
			break;
		case "not-http":
			console.log(`  ${color.dim("·")} ${rel} ${color.dim("(non-HTTP trigger)")}`);
			break;
		case "error":
			console.log(`  ${color.red("✗")} ${rel} ${color.red(`error: ${result.error}`)}`);
			break;
	}
}

function printSummary(results: PathResult[], dryRun: boolean, writeBackup: boolean): void {
	const counts = {
		added: results.filter((r) => r.kind === "added").length,
		rewrote: results.filter((r) => r.kind === "rewrote-root").length,
		already: results.filter((r) => r.kind === "already-explicit").length,
		skipped: results.filter((r) => r.kind === "no-trigger" || r.kind === "not-http").length,
		errors: results.filter((r) => r.kind === "error").length,
	};

	const action = dryRun ? "would be" : "were";
	console.log(color.bold("Summary:"));
	console.log(`  ${color.green(`${counts.added} ${action} updated`)} (added explicit path)`);
	if (counts.rewrote > 0)
		console.log(`  ${color.green(`${counts.rewrote} ${action} updated`)} (rewrote "/" → file-derived)`);
	console.log(`  ${color.dim(`${counts.already} already explicit`)}`);
	if (counts.skipped > 0) console.log(`  ${color.dim(`${counts.skipped} skipped (non-HTTP / no trigger)`)}`);
	if (counts.errors > 0) console.log(`  ${color.red(`${counts.errors} errors`)}`);

	if (!dryRun && (counts.added > 0 || counts.rewrote > 0) && writeBackup) {
		console.log("");
		console.log(color.dim("Backups written as <name>.json.bak. Delete them once verified."));
	}
	if (dryRun && (counts.added > 0 || counts.rewrote > 0)) {
		console.log("");
		console.log(color.cyan("Re-run without --dry-run to apply."));
	}
}

async function resolveJsonRoot(cwd: string, explicit: string | null): Promise<string | null> {
	if (explicit) {
		const abs = path.isAbsolute(explicit) ? explicit : path.resolve(cwd, explicit);
		if (await dirExists(abs)) return abs;
		return null;
	}
	const candidates = [path.join(cwd, "workflows", "json"), path.join(cwd, "triggers", "http", "workflows", "json")];
	for (const c of candidates) {
		if (await dirExists(c)) return c;
	}
	return null;
}

async function dirExists(p: string): Promise<boolean> {
	try {
		const stat = await fsp.stat(p);
		return stat.isDirectory();
	} catch {
		return false;
	}
}

async function collectJsonFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	await walkJson(root, out);
	out.sort();
	return out;
}

async function collectTsFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	await walkTs(root, out);
	out.sort();
	return out;
}

async function walkJson(dir: string, out: string[]): Promise<void> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fsp.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await walkJson(full, out);
		} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
			out.push(full);
		}
	}
}

async function walkTs(dir: string, out: string[]): Promise<void> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fsp.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name.startsWith("_") || entry.name === "node_modules") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await walkTs(full, out);
		} else if (
			entry.isFile() &&
			(entry.name.toLowerCase().endsWith(".ts") || entry.name.toLowerCase().endsWith(".js")) &&
			entry.name !== "index.ts" &&
			entry.name !== "index.js"
		) {
			out.push(full);
		}
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || value === undefined) return false;
	if (Array.isArray(value)) return false;
	return typeof value === "object";
}
