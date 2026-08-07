#!/usr/bin/env bun
/**
 * Make every emitted `dist/` loadable by Node's native ESM loader (#687).
 *
 * `tsc` copies module specifiers through verbatim, so source written as
 * `import Configuration from "./Configuration"` emits exactly that. Bun (and
 * any bundler) resolves the extensionless form; **Node's ESM loader does
 * not** — it throws `ERR_MODULE_NOT_FOUND`. Everything in this repo runs
 * under Bun, so the whole publishable surface shipped Bun-only for months:
 * `node -e "await import('@blokjs/runner')"`, `npx blokctl`, vitest and
 * Next.js SSR consumers were all broken.
 *
 * This runs after `nx run-many -t build` (see the root `build` script) and
 * rewrites relative specifiers in the emitted `.js` / `.d.ts` files to the
 * explicit form Node requires:
 *
 *   "./Configuration"  →  "./Configuration.js"      (sibling file)
 *   "./hmr"            →  "./hmr/index.js"          (directory)
 *
 * Specifiers are located with the TypeScript parser, not a regex, so
 * `import`/`export … from`, bare side-effect `import "./x"`, dynamic
 * `import("./x")`, `import type`, and `.d.ts`-only `import("./x").T` type
 * references are all covered and string data that merely looks like an
 * import is not.
 *
 * The rewrite is conservative by construction: it only ever *adds* an
 * extension, and only when the target actually exists on disk next to the
 * emitted file. An unresolvable specifier is reported and left alone (and
 * fails the run) rather than guessed at.
 *
 * Sourcemaps are deleted rather than kept in sync. Published artifacts ship
 * `dist` only, so the maps pointed at `src/` files that were never in the
 * tarball — consumers got "points to missing source files" warning spam for
 * maps that could not work anyway.
 *
 * The durable guarantee is `scripts/check-packed-exports.ts`, which imports
 * every packed tarball's every exports subpath under real Node. This script
 * fixes the artifacts; that one proves they stay fixed.
 *
 *   bun scripts/fix-esm-extensions.ts          # rewrite in place
 *   bun scripts/fix-esm-extensions.ts --check  # fail if anything would change
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// `import.meta.url`, not Bun's `import.meta.dir` — the resolver below is
// unit-tested under vitest, where the Bun-only property is undefined. Fitting,
// given what this script is for.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Emitted trees that are NOT `tsc` output and must be left byte-identical:
 * the CLI copies a source snapshot of the repo (`scaffold-repo`) and the
 * built Studio SPA (`studio-dist`) into its own `dist`.
 */
const SKIP_DIRS = new Set(["scaffold-repo", "studio-dist", "node_modules"]);

/** Extensions that already tell Node exactly what to load. */
const EXPLICIT = /\.(js|mjs|cjs|json|node|css|wasm)$/;

/**
 * `"."` and `".."` are relative too — `import(".")` (a self-referential type
 * import in `RunnerNodeBase.ts`) emits a directory specifier Node cannot
 * resolve, exactly like `"./hmr"` can't.
 */
function isRelative(spec: string): boolean {
	return spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../");
}

/**
 * Resolve one relative specifier against the emitted tree.
 *
 * `fromFile` decides which extensions count as "the target exists": a
 * `.d.ts` file's `./x` means `x.d.ts`, a `.js` file's means `x.js`. Both
 * rewrite to `./x.js` — that is the specifier Node needs at runtime and the
 * one TypeScript follows back to `x.d.ts` under node16/nodenext resolution.
 *
 * Returns the rewritten specifier, or `null` to leave it untouched.
 * `exists` is injected so the resolution rules are unit-testable without a
 * fixture tree on disk.
 */
export function resolveSpecifier(fromFile: string, spec: string, exists: (p: string) => boolean): string | null {
	if (!isRelative(spec)) return null;
	if (EXPLICIT.test(spec)) return null;

	const declaration = fromFile.endsWith(".d.ts") || fromFile.endsWith(".d.mts");
	const target = resolve(dirname(fromFile), spec);
	const index = declaration ? join(target, "index.d.ts") : join(target, "index.js");

	// "." / ".." / "./x/" can only ever mean a directory — never try the
	// sibling-file branch for them, or "." would become "..js".
	const bare = spec.replace(/\/+$/, "");
	if (spec === "." || spec === ".." || spec.endsWith("/")) return exists(index) ? `${bare}/index.js` : null;

	// File beats directory — `./hmr.js` wins over `./hmr/index.js` when both
	// exist, matching Node's own resolution order for a CommonJS-style guess
	// and TypeScript's for a declaration file.
	if (exists(declaration ? `${target}.d.ts` : `${target}.js`)) return `${bare}.js`;
	if (exists(index)) return `${bare}/index.js`;
	if (exists(`${target}.json`)) return `${bare}.json`;
	return null;
}

/** Every module specifier position the emitted files can carry. */
function specifiers(sf: ts.SourceFile): ts.StringLiteralLike[] {
	const found: ts.StringLiteralLike[] = [];
	const visit = (node: ts.Node): void => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteralLike(node.moduleSpecifier)
		) {
			found.push(node.moduleSpecifier);
		} else if (
			ts.isImportTypeNode(node) &&
			ts.isLiteralTypeNode(node.argument) &&
			ts.isStringLiteralLike(node.argument.literal)
		) {
			// `.d.ts` inline type reference: `import("./Foo").Foo`
			found.push(node.argument.literal);
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length > 0 &&
			ts.isStringLiteralLike(node.arguments[0])
		) {
			found.push(node.arguments[0]);
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference) &&
			ts.isStringLiteralLike(node.moduleReference.expression)
		) {
			found.push(node.moduleReference.expression);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return found;
}

export interface RewriteResult {
	text: string;
	changed: number;
	/** Relative specifiers that resolved to nothing on disk — a real breakage, not a no-op. */
	unresolved: string[];
}

/** Rewrite every relative specifier in one emitted file. */
export function rewriteFile(fileName: string, text: string, exists: (p: string) => boolean): RewriteResult {
	const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.Deferred);
	const edits: Array<{ start: number; end: number; spec: string }> = [];
	const unresolved: string[] = [];

	for (const literal of specifiers(sf)) {
		const spec = literal.text;
		if (!isRelative(spec)) continue;
		const next = resolveSpecifier(fileName, spec, exists);
		if (next === null) {
			if (!EXPLICIT.test(spec)) unresolved.push(spec);
			continue;
		}
		if (next === spec) continue;
		// Replace inside the quotes only; getStart()/getEnd() include them.
		edits.push({ start: literal.getStart(sf) + 1, end: literal.getEnd() - 1, spec: next });
	}

	if (edits.length === 0) return { text, changed: 0, unresolved };
	let out = text;
	for (const e of edits.sort((a, b) => b.start - a.start)) {
		out = out.slice(0, e.start) + e.spec + out.slice(e.end);
	}
	return { text: out, changed: edits.length, unresolved };
}

/** Workspace package directories that produced a `dist/`. */
function distDirs(): string[] {
	const globs = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).workspaces ?? []) as string[];
	const dirs = new Set<string>();
	for (const pattern of globs) {
		for (const rel of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: ROOT })) {
			if (rel.includes("node_modules")) continue;
			const dist = join(ROOT, dirname(rel), "dist");
			if (existsSync(dist)) dirs.add(dist);
		}
	}
	return [...dirs].sort();
}

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

function main(): void {
	const check = process.argv.includes("--check");
	let rewritten = 0;
	let files = 0;
	let maps = 0;
	const broken: string[] = [];
	const stale: string[] = [];

	for (const dist of distDirs()) {
		for (const file of walk(dist)) {
			if (/\.(js|mjs|cjs|d\.ts|d\.mts)\.map$/.test(file)) {
				maps++;
				if (!check) rmSync(file);
				continue;
			}
			if (!/\.(js|mjs|cjs|ts|mts)$/.test(file)) continue;
			const text = readFileSync(file, "utf8");
			const result = rewriteFile(file, text, existsSync);
			for (const spec of result.unresolved) broken.push(`${file.slice(ROOT.length + 1)} → ${spec}`);
			// The maps are gone; leave no dangling reference behind.
			const next = result.text.replace(/\n\/\/# sourceMappingURL=.*\.map\s*$/, "\n");
			if (next === text) continue;
			files++;
			rewritten += result.changed;
			if (check) stale.push(file.slice(ROOT.length + 1));
			else writeFileSync(file, next);
		}
	}

	if (broken.length > 0) {
		console.error(`\nUnresolvable relative specifiers in dist (${broken.length}):`);
		for (const b of broken) console.error(`  ${b}`);
		console.error("\nThe emitted file imports something that is not on disk — fix the source, not this script.");
		process.exit(1);
	}
	if (check && stale.length > 0) {
		console.error(`${stale.length} emitted file(s) still carry extensionless imports or sourcemap links:`);
		for (const s of stale.slice(0, 20)) console.error(`  ${s}`);
		console.error("\nRun `bun run scripts/fix-esm-extensions.ts`.");
		process.exit(1);
	}
	console.log(
		check
			? "fix-esm-extensions: dist is Node-ESM clean."
			: `fix-esm-extensions: ${rewritten} specifier(s) in ${files} file(s), ${maps} sourcemap(s) dropped.`,
	);
}

if (import.meta.main) main();
