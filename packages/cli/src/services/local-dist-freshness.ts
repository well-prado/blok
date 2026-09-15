/**
 * `--local` links `@blokjs/*` at `file:<repo>/<package>` — and a `file:` link
 * resolves to that package's **`dist/`**, never its sources. So a repo whose
 * `dist/` is older than its `src/` scaffolds a project built against the
 * PREVIOUS build: the TypeScript compile of the generated project then fails
 * with implicit-any / missing-member errors that describe code the linked
 * package no longer has (#1067).
 *
 * The usual cause is an nx build that served a cached `dist` for inputs that
 * had already changed. Say so, with the recovery, instead of letting the user
 * debug type errors in code they did not write.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Newest mtime under `dir`, or 0 when it does not exist / is empty. */
function newestMtime(dir: string): number {
	if (!existsSync(dir)) return 0;
	let newest = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		// ponytail: node_modules under a package dir is never an input or an
		// output; skipping it keeps this a few thousand stats, not a million.
		if (entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		const mtime = entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs;
		if (mtime > newest) newest = mtime;
	}
	return newest;
}

export interface StaleLink {
	/** Absolute path of the linked package directory. */
	dir: string;
	/** True when there is no `dist/` at all — never built. */
	neverBuilt: boolean;
}

/**
 * The linked packages whose `dist/` does not include their current `src/`.
 * `dirs` are absolute package directories (what a `file:` link points at).
 */
export function findStaleDists(dirs: readonly string[]): StaleLink[] {
	const stale: StaleLink[] = [];
	for (const dir of new Set(dirs)) {
		const src = join(dir, "src");
		if (!existsSync(src)) continue; // not a built-from-source package
		const builtAt = newestMtime(join(dir, "dist"));
		if (builtAt === 0) {
			stale.push({ dir, neverBuilt: true });
		} else if (newestMtime(src) > builtAt) {
			stale.push({ dir, neverBuilt: false });
		}
	}
	return stale;
}

/** One warning naming every stale link and the recovery. */
export function formatStaleDistWarning(stale: readonly StaleLink[], repoRoot: string): string {
	const lines = [
		`Warning: ${stale.length} linked package${stale.length === 1 ? " has a dist/ that is" : "s have a dist/ that is"} older than its src/:`,
		...stale.map(({ dir, neverBuilt }) => `  - ${dir}${neverBuilt ? " (never built)" : ""}`),
		"  `--local` links dist/, so this project is scaffolded against the previous build.",
		`  Fix: cd ${repoRoot} && bun run build   (if that changes nothing: bunx nx reset && bun run build)`,
	];
	return lines.join("\n");
}

/** Collect the absolute directories a package.json's `file:` deps point at. */
export function fileLinkDirs(packageJson: Record<string, unknown>): string[] {
	const dirs: string[] = [];
	for (const group of ["dependencies", "devDependencies", "overrides", "resolutions"]) {
		const deps = packageJson[group];
		if (!deps || typeof deps !== "object") continue;
		for (const value of Object.values(deps as Record<string, unknown>)) {
			if (typeof value === "string" && value.startsWith("file:")) dirs.push(value.slice("file:".length));
		}
	}
	return dirs;
}
