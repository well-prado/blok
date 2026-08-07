#!/usr/bin/env bun
/**
 * Source-level companion to fix-esm-extensions.ts (#687), for the code the
 * scaffold COPIES INTO USER PROJECTS (#709).
 *
 * The post-build fixup heals every published package's dist/ — but scaffolded
 * projects compile the copied template SOURCE with their own tsc, which does
 * not rewrite specifiers. An extensionless `import X from "./Foo"` in
 * `triggers/http/src/**` therefore ships Bun-only ESM to every user who runs
 * `npm run build && node dist/...` (any Node container / serverless deploy).
 *
 * This script rewrites relative specifiers in the template-source trees to the
 * explicit `./Foo.js` form (the NodeNext convention: the specifier names the
 * EMITTED file; tsc maps it back to Foo.ts while typechecking). Idempotent —
 * explicit specifiers are left alone. `--check` reports instead of writing,
 * and is wired into ci-local gates so new template code cannot regress.
 *
 * Reuses the battle-tested resolver from fix-esm-extensions.ts; only the
 * `exists` predicate differs — a queried emitted path (`Foo.js`,
 * `dir/index.js`) counts as present when its SOURCE (`Foo.ts`/`.tsx`/`.js`)
 * is on disk.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { rewriteFile } from "./fix-esm-extensions";

const ROOT = resolve(import.meta.dir, "..");

/** Trees the scaffold bundles or copies into user projects (see ASSET_DIRS in
 * packages/cli/scripts/bundle-scaffold-assets.ts + templates/). */
const SRC_DIRS = ["triggers", "templates", "examples/ts-workflows", "sdk"];

const SKIP = new Set(["node_modules", "dist", ".blok", "target", "__pycache__"]);

function sourceExists(emittedPath: string): boolean {
	// The specifier names the EMITTED file; accept it when the source exists.
	if (existsSync(emittedPath)) return true;
	if (emittedPath.endsWith(".js")) {
		const stem = emittedPath.slice(0, -3);
		return existsSync(`${stem}.ts`) || existsSync(`${stem}.tsx`) || existsSync(`${stem}.mts`);
	}
	return false;
}

function* walk(dir: string): Generator<string> {
	for (const entry of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: dir, onlyFiles: true })) {
		if (entry.split("/").some((seg) => SKIP.has(seg))) continue;
		yield join(dir, entry);
	}
}

const check = process.argv.includes("--check");
let files = 0;
let edits = 0;
const dirty: string[] = [];
const unresolved: string[] = [];

for (const rel of SRC_DIRS) {
	const dir = join(ROOT, rel);
	if (!existsSync(dir)) continue;
	for (const file of walk(dir)) {
		const text = readFileSync(file, "utf8");
		const result = rewriteFile(file, text, sourceExists);
		for (const spec of result.unresolved) unresolved.push(`${file}: ${spec}`);
		if (result.changed === 0) continue;
		files++;
		edits += result.changed;
		dirty.push(file);
		if (!check) writeFileSync(file, result.text);
	}
}

// Unresolved relative specifiers in template source are almost always a
// missing file — report, don't fail: some template imports resolve only
// inside a generated project (the scaffold rewrites them at copy time).
if (unresolved.length > 0) {
	console.warn(`fix-esm-extensions-src: ${unresolved.length} unresolved relative specifier(s) left untouched:`);
	for (const u of unresolved.slice(0, 20)) console.warn(`  ${u}`);
}

if (check && files > 0) {
	console.error(`✗ ${edits} extensionless relative import(s) in ${files} template-source file(s):`);
	for (const f of dirty.slice(0, 20)) console.error(`  ${f}`);
	console.error("  Run: bun run scripts/fix-esm-extensions-src.ts");
	process.exit(1);
}
console.log(
	check
		? "✓ Template sources carry explicit ESM extensions."
		: `fix-esm-extensions-src: ${edits} specifier(s) in ${files} file(s).`,
);
