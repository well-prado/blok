#!/usr/bin/env bun
/**
 * The source-under-Bun gate (#702) — sibling of #696's packaging gate
 * (`check-packed-exports.ts`, dist-under-Node). Together they cover both
 * execution modes nobody was checking:
 *
 *   - dist-under-Node  → check-packed-exports.ts (#687/#696)
 *   - source-under-Bun → this file (#702)
 *
 * Everything in this repo is developed and tested through a bundler
 * (vitest/esbuild) that tolerates ambiguous type/value re-exports. Bun's
 * per-file source loader — used by `bun -e`, `bun run` against source,
 * in-monorepo scripts, and bundler source-aliasing — does not: a plain
 * (non-`type`) `import`/`export` of a name that turns out to be a type
 * alias or interface (erased at the target file, no runtime binding) round-
 * trips through a synthesized re-export that Bun rejects, either as
 * `SyntaxError: export default cannot be used with export *` (default
 * exports) or `SyntaxError: export 'X' not found in './Y.js'` (named
 * exports). Nothing ever imported package SOURCE under Bun, so this shipped
 * silently in @blokjs/runner, @blokjs/shared, and @blokjs/trigger-grpc for
 * months — the published `dist/` (checked by check-packed-exports.ts) was
 * never affected, since tsc/esbuild's bundler-mode analysis erases these
 * type-only names before Bun ever sees them.
 *
 * This loads every publishable package's SOURCE entry the way an
 * in-monorepo script or a bundler aliasing to source would:
 *
 *   bun run check:source-imports
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLISHABLE } from "./release";

const ROOT = join(import.meta.dir, "..");

interface PackageJson {
	bin?: string | Record<string, string>;
}

function readPkg(dir: string): PackageJson {
	return JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
}

/** `src/index.ts` is the convention; the handful of flat-layout node packages fall back to a root `index.ts`. */
function resolveEntry(dir: string): string {
	const nested = join(ROOT, dir, "src", "index.ts");
	if (existsSync(nested)) return nested;
	const flat = join(ROOT, dir, "index.ts");
	if (existsSync(flat)) return flat;
	throw new Error(`No src/index.ts or index.ts found under ${dir}`);
}

async function main(): Promise<void> {
	const failures: { name: string; entry: string; error: string }[] = [];
	let checked = 0;
	let skipped = 0;

	for (const { dir, name } of PUBLISHABLE) {
		// A bin package's entry RUNS on import (commander parses argv, may
		// call process.exit) — same reasoning as check-packed-exports.ts's
		// bin handling. Importing it proves nothing about the export shapes
		// this gate cares about, so it's out of scope here (its dist form is
		// exercised by the packaging gate instead).
		if (readPkg(dir).bin !== undefined) {
			skipped++;
			continue;
		}

		const entry = resolveEntry(dir);
		try {
			await import(entry);
			checked++;
		} catch (err) {
			failures.push({ name, entry, error: err instanceof Error ? err.message : String(err) });
		}
	}

	console.log(`Checked ${checked} package source entries under Bun (${skipped} bin package(s) skipped).`);

	if (failures.length > 0) {
		console.error(`\n\x1b[1;31m${failures.length} package(s) failed to import their SOURCE entry under Bun:\x1b[0m`);
		for (const f of failures) console.error(`\n--- ${f.name} (${f.entry})\n${f.error}`);
		process.exit(1);
	}

	console.log("\n\x1b[1;32m✅ Every publishable package's source entry imports cleanly under Bun.\x1b[0m");
}

if (import.meta.main) main();
