#!/usr/bin/env bun
/**
 * The packaging gate (#687) — make "ships Bun-only" unrepresentable.
 *
 * Everything in this repo runs under Bun, whose resolver accepts specifiers
 * Node's ESM loader rejects. That let `@blokjs/*` ship for months with
 * extensionless relative imports in `dist/`, breaking `npx blokctl`, vitest,
 * plain `node`, and Next.js SSR consumers. Nothing caught it because nothing
 * ever loaded the artifact the way a user does.
 *
 * So this gate loads it the way a user does:
 *
 *   1. `npm pack` every publishable package — the TARBALL, so `files`,
 *      `.npmignore` and the exports map apply exactly as at publish time.
 *      Never the workspace: its symlinks and Bun's resolver mask the failure.
 *   2. `npm install` all of them into one throwaway consumer project.
 *   3. `node --input-type=module -e "await import('<pkg>/<subpath>')"` for
 *      EVERY subpath in every exports map, wildcards expanded against the
 *      installed files.
 *   4. Run `tests/e2e/node-consumer` — vitest on Node, zero `deps.inline`.
 *   5. `publint` + `@arethetypeswrong/cli` over each tarball.
 *
 *   bun run check:packaging          # everything
 *   bun run check:packaging --keep   # leave the temp consumer for poking at
 *
 * Requires a fresh `bun run build` (which runs `scripts/fix-esm-extensions.ts`).
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLISHABLE } from "./release";

const ROOT = join(import.meta.dir, "..");
const KEEP = process.argv.includes("--keep");

/** Exports-map targets that are not JavaScript modules and cannot be `import`ed as one. */
const NOT_A_MODULE = /\.(json|css|txt|md|proto)$/;

/**
 * A compiled test file in a packed tarball (#697/#716/#719 — `blokctl`,
 * `@blokjs/api-call`, `@blokjs/if-else`, `@blokjs/trigger-grpc` all shipped
 * these because their `tsconfig.json` had no `exclude` for test sources, so
 * `tsc` compiled `test/*.ts` / `__tests__/*.ts` straight into `dist/`, and
 * `"files": ["dist"]` allowlisted the whole directory into the tarball).
 * Matches the same shapes across both test-dir conventions this repo uses.
 */
const TEST_ARTIFACT = /\.test\.|__tests__|\.spec\./;

interface PackedFile {
	path: string;
}

interface PackageJson {
	name: string;
	version: string;
	type?: string;
	main?: string;
	bin?: string | Record<string, string>;
	exports?: unknown;
}

function run(cmd: string, args: string[], cwd: string): { ok: boolean; out: string } {
	const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: process.env });
	return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function step(label: string): void {
	console.log(`\n\x1b[1;36m==> ${label}\x1b[0m`);
}

/** npm's tarball naming is deterministic: `@scope/name` → `scope-name-version.tgz`. */
function tarballName(pkg: PackageJson): string {
	return `${pkg.name.replace(/^@/, "").replace(/\//g, "-")}-${pkg.version}.tgz`;
}

/** Follow an exports-map value down to the file it ultimately points at. */
function exportTarget(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value === null || typeof value !== "object") return null;
	const conditions = value as Record<string, unknown>;
	for (const key of ["import", "default", "node", "require"]) {
		if (key in conditions) {
			const resolved = exportTarget(conditions[key]);
			if (resolved !== null) return resolved;
		}
	}
	return null;
}

/**
 * Every subpath a consumer may `import` from an installed package.
 *
 * A `"./*"` wildcard is expanded against the files actually present in the
 * install — that is the only honest reading of "every subpath in its exports
 * map", and it is where deep internal modules (which no barrel happens to
 * re-export) get their only coverage.
 */
function subpathsOf(pkg: PackageJson, installedDir: string): string[] {
	if (pkg.exports === undefined || pkg.exports === null) {
		// No exports map: `main` is the entire public surface. A package with
		// neither `exports` nor `main` (e.g. @blokjs/syntax — TextMate grammar
		// JSON consumed by file path, never `import`ed) has no JS entrypoint at
		// all, so there is nothing to import. Node's failure for that case
		// ("Cannot find package '<abs path>/index.js'") also happens to match
		// `isOptionalPeerMiss` below, which would otherwise silently wave the
		// missing entrypoint through as an "optional peer not installed" skip —
		// so this must be filtered here, before that heuristic ever sees it.
		return pkg.main === undefined ? [] : [pkg.name];
	}
	const map = pkg.exports as Record<string, unknown>;
	const out: string[] = [];
	for (const [key, value] of Object.entries(map)) {
		if (key === "./package.json") continue;
		const target = exportTarget(value);
		if (target === null || NOT_A_MODULE.test(target)) continue;

		if (!key.includes("*")) {
			out.push(key === "." ? pkg.name : `${pkg.name}${key.slice(1)}`);
			continue;
		}
		// e.g. key "./*" → target "./dist/*.js". Node's exports `*` matches
		// across directory separators, so `@blokjs/runner/tracing/RunTracker`
		// is a real subpath — expand recursively or the deep internal modules
		// (the ones no barrel re-exports, so nothing else would load them) go
		// completely uncovered.
		const [rawPrefix, suffix] = target.split("*");
		const prefix = rawPrefix.replace(/^\.\//, "");
		for (const rel of new Bun.Glob(`${prefix}**`).scanSync({ cwd: installedDir })) {
			if (!rel.startsWith(prefix) || !rel.endsWith(suffix)) continue;
			const star = rel.slice(prefix.length, rel.length - suffix.length);
			out.push(`${pkg.name}${key.slice(1).replace("*", star)}`);
		}
	}
	return [...new Set(out)].sort();
}

/**
 * A missing BARE package is the consumer declining to install an optional peer
 * (`better-sqlite3`, `pg`, the OTel exporters) — not a packaging defect. A
 * missing path INSIDE the installed tree is exactly the bug this gate exists
 * for, and always fails.
 */
function isOptionalPeerMiss(output: string): boolean {
	return /Cannot find package '(?!@blokjs\/)/.test(output) && !/Cannot find module '/.test(output);
}

/**
 * The invariant this whole gate depends on (#697): every workspace package is
 * EITHER `private: true` OR listed in `PUBLISHABLE` — never neither. A package
 * that's `private: false`/unset and absent from `PUBLISHABLE` looks
 * publishable (npm would happily accept `npm publish` from that directory)
 * but this gate never packs it, never imports it under Node, never lints it —
 * exactly how `@blokjs/browser`, `@blokjs/syntax`, `@blokjs/lsp-server`, and
 * `blok-vscode` went unnoticed for months. Discovers workspace members the
 * same way the package manager does: the root `package.json#workspaces`
 * globs, not a hand-maintained list that can itself drift.
 */
export function checkPublishInvariant(): void {
	const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { workspaces?: string[] };
	const publishableNames = new Set(PUBLISHABLE.map((p) => p.name));
	const seen = new Set<string>();
	const violations: string[] = [];
	for (const pattern of rootPkg.workspaces ?? []) {
		for (const rel of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: ROOT })) {
			if (rel.includes("node_modules/") || seen.has(rel)) continue;
			seen.add(rel);
			const pkg = JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as { name?: string; private?: boolean };
			if (pkg.private === true) continue;
			if (pkg.name !== undefined && publishableNames.has(pkg.name)) continue;
			violations.push(`${rel} (name: ${pkg.name ?? "<missing>"}) is not private:true and not in PUBLISHABLE`);
		}
	}
	if (violations.length > 0) {
		console.error(`\n\x1b[1;31m${violations.length} workspace package(s) are neither private nor publishable:\x1b[0m`);
		for (const v of violations) console.error(`  - ${v}`);
		console.error(
			'\nEach one needs `"private": true` in its package.json, OR an entry in PUBLISHABLE (scripts/release.ts).',
		);
		process.exit(1);
	}
}

function main(): void {
	step("publish invariant: every workspace package is private:true or in PUBLISHABLE");
	checkPublishInvariant();
	console.log("  OK — no third state.");

	const tmp = mkdtempSync(join(tmpdir(), "blok-packaging-"));
	const tarballs = join(tmp, "tarballs");
	const consumer = join(tmp, "consumer");
	mkdirSync(tarballs);
	if (!KEEP) process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
	console.log(`Temp workspace: ${tmp}`);

	step(`npm pack ${PUBLISHABLE.length} publishable packages`);
	const packed: Array<{ pkg: PackageJson; tarball: string }> = [];
	const testArtifacts: string[] = [];
	for (const { dir } of PUBLISHABLE) {
		const pkgDir = join(ROOT, dir);
		const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as PackageJson;
		// `--json` rides alongside `--silent` (confirmed: `--silent` only
		// suppresses the human-readable listing, not `--json`'s stdout) so the
		// packed file list — the exact contents `npm publish` would ship — comes
		// for free off the same call instead of a second `npm pack --dry-run`.
		const r = run("npm", ["pack", "--pack-destination", tarballs, "--json", "--silent"], pkgDir);
		const tarball = join(tarballs, tarballName(pkg));
		if (!r.ok || !existsSync(tarball)) {
			console.error(`npm pack failed for ${pkg.name}:\n${r.out}`);
			process.exit(1);
		}
		const [info] = JSON.parse(r.out) as Array<{ files: PackedFile[] }>;
		for (const f of info?.files ?? []) {
			if (TEST_ARTIFACT.test(f.path)) testArtifacts.push(`${pkg.name}: ${f.path}`);
		}
		packed.push({ pkg, tarball });
		console.log(`  ${pkg.name}@${pkg.version}`);
	}
	if (testArtifacts.length > 0) {
		console.error(`\n\x1b[1;31m${testArtifacts.length} packed file(s) look like compiled test artifacts:\x1b[0m`);
		for (const v of testArtifacts) console.error(`  - ${v}`);
		console.error(
			"\nAdd a tsconfig `exclude` for test sources (see core/runner/tsconfig.json) so tsc never compiles them into dist/.",
		);
		process.exit(1);
	}

	step("npm install the tarballs into a throwaway consumer");
	cpSync(join(ROOT, "tests/e2e/node-consumer"), consumer, { recursive: true });
	const install = run(
		"npm",
		[
			"install",
			"--no-audit",
			"--no-fund",
			"--loglevel",
			"error",
			"vitest@^4.0.18",
			"zod@^3.24.2",
			...packed.map((p) => p.tarball),
		],
		consumer,
	);
	if (!install.ok) {
		console.error(`npm install failed:\n${install.out}`);
		process.exit(1);
	}

	step("import every exports subpath under Node's ESM loader");
	const failures: string[] = [];
	let imported = 0;
	let skipped = 0;
	for (const { pkg } of packed) {
		const installed = join(consumer, "node_modules", pkg.name);

		// A bin package's entry RUNS on import (commander parses argv and
		// exits), so importing it proves nothing and fails for the wrong
		// reason. Execute the bin instead — same loader, real user path.
		if (pkg.bin !== undefined) {
			for (const rel of Object.values(typeof pkg.bin === "string" ? { [pkg.name]: pkg.bin } : pkg.bin)) {
				const r = run("node", [join(installed, rel), "--version"], consumer);
				if (r.ok) imported++;
				else failures.push(`${pkg.name} bin ${rel}\n${r.out.trim().split("\n").slice(0, 6).join("\n")}`);
			}
			console.log(`  ${pkg.name}: bin`);
			continue;
		}

		const subpaths = subpathsOf(pkg, installed);
		for (const subpath of subpaths) {
			const r = run("node", ["--input-type=module", "-e", `await import(${JSON.stringify(subpath)})`], consumer);
			if (r.ok) {
				imported++;
				continue;
			}
			if (isOptionalPeerMiss(r.out)) {
				skipped++;
				continue;
			}
			failures.push(`${subpath}\n${r.out.trim().split("\n").slice(0, 6).join("\n")}`);
		}
		console.log(`  ${pkg.name}: ${subpaths.length} subpath(s)`);
	}
	if (failures.length > 0) {
		console.error(`\n\x1b[1;31m${failures.length} subpath(s) failed to import under Node:\x1b[0m`);
		for (const f of failures) console.error(`\n--- ${f}`);
		process.exit(1);
	}
	console.log(`  ${imported} imported, ${skipped} skipped (optional peer not installed)`);

	step("vitest on Node in a consumer with no resolution workarounds");
	const vitest = run("npx", ["--no-install", "vitest", "run"], consumer);
	console.log(vitest.out);
	if (!vitest.ok) {
		console.error("Consumer vitest run failed.");
		process.exit(1);
	}

	// #688 — the SAME tests under Bun's runner. A consumer picks one runner; the
	// framework must not care which, so both are proven on the packed artifacts.
	step("bun test in the same consumer");
	const bunTest = run("bun", ["test"], consumer);
	console.log(bunTest.out);
	if (!bunTest.ok) {
		console.error("Consumer bun test run failed.");
		process.exit(1);
	}

	// Both linters are pinned root devDependencies, not `npx --yes` — a gate
	// that silently follows `latest` is a gate that changes under you.
	const bin = (name: string): string => join(ROOT, "node_modules", ".bin", name);
	let lintFailed = false;

	step("publint");
	for (const { pkg, tarball } of packed) {
		const r = run(bin("publint"), [tarball, "--level", "error"], tmp);
		if (!r.ok) {
			lintFailed = true;
			console.error(`\n${pkg.name}:\n${r.out}`);
		}
	}

	step("@arethetypeswrong/cli");
	for (const { pkg, tarball } of packed) {
		// `--profile esm-only` applies ONLY to `"type": "module"` packages: for
		// those, node10 (no exports-map support) and node16-from-CJS (`require()`
		// of ESM) are expected-and-intended misses, not defects, and what this
		// gate is for is the third column — node16-from-ESM — where an
		// unfollowable specifier inside a `.d.ts` shows up as an internal
		// resolution error. A genuinely CJS publishable package (#697 —
		// @blokjs/lsp-server has no `"type"` field) gets the full default
		// "strict" profile instead: esm-only would IGNORE its node10/node16-cjs
		// resolutions rather than check them, which is a false pass for the exact
		// module kind that package actually ships.
		const profileArgs = pkg.type === "module" ? ["--profile", "esm-only"] : [];
		const r = run(bin("attw"), [tarball, ...profileArgs, "--format", "table-flipped"], tmp);
		if (!r.ok) {
			lintFailed = true;
			console.error(`\n${pkg.name}:\n${r.out}`);
		}
	}
	if (lintFailed) process.exit(1);

	console.log("\n\x1b[1;32m✅ Packaging gate passed — every packed subpath imports under Node.\x1b[0m");
}

if (import.meta.main) main();
