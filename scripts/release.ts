#!/usr/bin/env bun
/**
 * Lockstep publish for the 15 Blok public packages (8 pre-v0.6, plus 7
 * added in v0.6.0 to support the new trigger surface — sse, websocket,
 * webhook, pubsub, cron, grpc, plus the helpers node).
 *
 * Pre-flight: lockstep version, cross-package dep alignment, CLI scaffold
 * constants, git tag, clean tree. Then ordered npm publish with a single
 * batched OTP.
 *
 * Does NOT bump versions, push tags, or commit — see
 * docs/c/devtools/release-runbook.mdx for the surrounding flow.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

interface PackageJson {
	name: string;
	version: string;
	private?: boolean;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

interface Publishable {
	dir: string;
	name: string;
}

/**
 * Publish order respects the dep graph: every dependency lists before
 * the consumers that import it. `@blokjs/shared` first (no internal
 * deps), `@blokjs/helper` and the node packages next (depend on
 * shared), `@blokjs/runner` after them, then the new v0.6 trigger
 * surface that depends on runner, and `blokctl` last.
 *
 * The v0.6.0 release expanded the list from 8 to 15. `trigger-http`'s
 * source imports `@blokjs/trigger-sse`, `@blokjs/trigger-webhook`,
 * `@blokjs/trigger-websocket`, and `@blokjs/helpers` — scaffolded
 * projects can't `bun install` if any of those four isn't on npm.
 * `@blokjs/trigger-{cron, grpc, pubsub}` are part of the v0.6 surface
 * too and published alongside for parity. `@blokjs/syntax` /
 * `@blokjs/lsp-server` remain off npm until they grow user-visible
 * docs (CLI / IDE support only).
 */
const PUBLISHABLE: readonly Publishable[] = [
	// Foundation — no internal deps.
	{ dir: "core/shared", name: "@blokjs/shared" },
	{ dir: "core/workflow-helper", name: "@blokjs/helper" },
	// Node packages (depend on shared + helper).
	{ dir: "nodes/web/api-call@1.0.0", name: "@blokjs/api-call" },
	{ dir: "nodes/control-flow/if-else@1.0.0", name: "@blokjs/if-else" },
	{ dir: "nodes/web/react@1.0.0", name: "@blokjs/react" },
	{ dir: "nodes/utility/helpers@1.0.0", name: "@blokjs/helpers" },
	// Runner (consumes everything above).
	{ dir: "core/runner", name: "@blokjs/runner" },
	// Triggers (consume runner + shared + helper). Order amongst
	// themselves doesn't matter — none depend on another trigger.
	{ dir: "triggers/worker", name: "@blokjs/trigger-worker" },
	{ dir: "triggers/sse", name: "@blokjs/trigger-sse" },
	{ dir: "triggers/websocket", name: "@blokjs/trigger-websocket" },
	{ dir: "triggers/webhook", name: "@blokjs/trigger-webhook" },
	{ dir: "triggers/pubsub", name: "@blokjs/trigger-pubsub" },
	{ dir: "triggers/cron", name: "@blokjs/trigger-cron" },
	{ dir: "triggers/grpc", name: "@blokjs/trigger-grpc" },
	// CLI last — depends on everything via the scaffold.
	{ dir: "packages/cli", name: "blokctl" },
];

interface CliFlags {
	dryRun: boolean;
	otp: string | null;
	skipTests: boolean;
	skipBuild: boolean;
	yes: boolean;
	help: boolean;
}

interface Failure {
	category: string;
	detail: string;
}

const HELP = `Usage: bun run release [flags]

Publishes the 15 Blok public packages to npm in dependency order using a
single batched OTP. Runs pre-flight checks before publishing.

Flags:
  --dry-run           Run pre-flight + print plan, do not publish.
  --otp <code>        TOTP code for npm publish. Required unless --dry-run.
  --skip-tests        Skip the nx run-many test gate. Use sparingly.
  --skip-build        Skip the build step. Use sparingly.
  -y, --yes           Non-interactive confirmation. Combine with --otp.
  -h, --help          This message.

This script does NOT bump versions, push tags, or commit. See
docs/c/devtools/release-runbook.mdx for the surrounding flow.
`;

function parseArgs(argv: readonly string[]): CliFlags {
	const flags: CliFlags = {
		dryRun: false,
		otp: null,
		skipTests: false,
		skipBuild: false,
		yes: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--dry-run") flags.dryRun = true;
		else if (a === "--otp") flags.otp = argv[++i] ?? null;
		else if (a === "--skip-tests") flags.skipTests = true;
		else if (a === "--skip-build") flags.skipBuild = true;
		else if (a === "--yes" || a === "-y") flags.yes = true;
		else if (a === "--help" || a === "-h") flags.help = true;
		else throw new Error(`Unknown argument: ${a}`);
	}
	return flags;
}

function readPkg(relDir: string): PackageJson {
	const path = join(REPO_ROOT, relDir, "package.json");
	if (!existsSync(path)) throw new Error(`Missing package.json: ${path}`);
	const raw = readFileSync(path, "utf-8");
	return JSON.parse(raw) as unknown as PackageJson;
}

function checkLockstepVersion(packages: readonly { dir: string; pkg: PackageJson }[]): {
	failures: Failure[];
	version: string | null;
} {
	const versions = new Set(packages.map((p) => p.pkg.version));
	if (versions.size === 0) {
		return { failures: [{ category: "version", detail: "no packages parsed" }], version: null };
	}
	if (versions.size > 1) {
		const list = packages.map((p) => `${p.pkg.name}=${p.pkg.version}`).join(", ");
		return {
			failures: [{ category: "version", detail: `lockstep violated: ${list}` }],
			version: null,
		};
	}
	return { failures: [], version: [...versions][0] ?? null };
}

function findAllPackageJsons(): string[] {
	const result = spawnSync(
		"find",
		[
			".",
			"-name",
			"package.json",
			"-not",
			"-path",
			"*/node_modules/*",
			"-not",
			"-path",
			"*/.git/*",
			"-not",
			"-path",
			"*/dist/*",
			"-not",
			"-path",
			"*/.blok/*",
		],
		{ cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
	);
	if (result.status !== 0) throw new Error(`find failed: ${result.stderr}`);
	return result.stdout.trim().split("\n").filter(Boolean);
}

function rangeIncludesVersion(range: string, version: string): boolean {
	const m = range.match(/^[\^~]?(\d+)\.(\d+)\.(\d+)/);
	if (!m) return false;
	const v = version.match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!v) return false;
	return m[1] === v[1] && m[2] === v[2] && m[3] === v[3];
}

function checkCrossDepRanges(version: string, publishedNames: readonly string[]): Failure[] {
	const failures: Failure[] = [];
	const allPkgs = findAllPackageJsons();
	for (const rel of allPkgs) {
		const path = join(REPO_ROOT, rel);
		let pkg: PackageJson;
		try {
			pkg = JSON.parse(readFileSync(path, "utf-8")) as unknown as PackageJson;
		} catch {
			continue;
		}
		const sections: Record<string, Record<string, string> | undefined> = {
			dependencies: pkg.dependencies,
			devDependencies: pkg.devDependencies,
			peerDependencies: pkg.peerDependencies,
		};
		for (const [section, deps] of Object.entries(sections)) {
			if (!deps) continue;
			for (const [name, range] of Object.entries(deps)) {
				if (!publishedNames.includes(name)) continue;
				if (range === "workspace:*" || range === "*") continue;
				if (!rangeIncludesVersion(range, version)) {
					failures.push({
						category: "cross-dep",
						detail: `${rel}:${section}: ${name} has range "${range}" but workspace is at ${version}`,
					});
				}
			}
		}
	}
	return failures;
}

function checkCliConstants(version: string): Failure[] {
	const failures: Failure[] = [];
	const path = join(REPO_ROOT, "packages/cli/src/commands/create/project.ts");
	if (!existsSync(path)) {
		return [{ category: "cli-constants", detail: `missing ${path}` }];
	}
	const src = readFileSync(path, "utf-8");
	const tagMatch = src.match(/GITHUB_REPO_RELEASE_TAG\s*=\s*"(v[^"]+)"/);
	if (!tagMatch) {
		failures.push({
			category: "cli-constants",
			detail: "GITHUB_REPO_RELEASE_TAG not found in project.ts",
		});
	} else if (tagMatch[1] !== `v${version}`) {
		failures.push({
			category: "cli-constants",
			detail: `GITHUB_REPO_RELEASE_TAG="${tagMatch[1]}" but workspace is v${version}`,
		});
	}
	const rangeMatch = src.match(/BLOKJS_DEP_RANGE\s*=\s*"(\^[^"]+)"/);
	if (!rangeMatch) {
		failures.push({
			category: "cli-constants",
			detail: "BLOKJS_DEP_RANGE not found in project.ts",
		});
	} else if (!rangeIncludesVersion(rangeMatch[1], version)) {
		failures.push({
			category: "cli-constants",
			detail: `BLOKJS_DEP_RANGE="${rangeMatch[1]}" does not include ${version}`,
		});
	}
	return failures;
}

function checkGitTag(version: string): Failure[] {
	const tag = `v${version}`;
	const result = spawnSync("git", ["tag", "-l", tag], { cwd: REPO_ROOT, encoding: "utf-8" });
	if (result.status !== 0) {
		return [{ category: "git-tag", detail: `git tag -l failed: ${result.stderr}` }];
	}
	if (result.stdout.trim() !== tag) {
		return [{ category: "git-tag", detail: `git tag ${tag} not found locally` }];
	}
	return [];
}

function checkCleanTree(): Failure[] {
	const result = spawnSync("git", ["status", "--porcelain"], {
		cwd: REPO_ROOT,
		encoding: "utf-8",
	});
	if (result.status !== 0) {
		return [{ category: "git-tree", detail: `git status failed: ${result.stderr}` }];
	}
	if (result.stdout.trim().length > 0) {
		return [{ category: "git-tree", detail: `working tree not clean:\n${result.stdout}` }];
	}
	return [];
}

function publishOne(dir: string, otp: string): { ok: boolean; alreadyPublished: boolean; output: string } {
	const result = spawnSync("npm", ["publish", "--access", "public", "--otp", otp], {
		cwd: join(REPO_ROOT, dir),
		encoding: "utf-8",
	});
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	const alreadyPublished = /EPUBLISHCONFLICT|cannot publish over the previously published/i.test(output);
	return { ok: result.status === 0 || alreadyPublished, alreadyPublished, output };
}

function runStep(name: string, cmd: string, args: readonly string[]): boolean {
	console.log(`\n--- ${name} ---`);
	const result = spawnSync(cmd, [...args], { cwd: REPO_ROOT, stdio: "inherit" });
	return result.status === 0;
}

function reportFailures(failures: readonly Failure[]): void {
	for (const f of failures) console.log(`  [FAIL] ${f.category}: ${f.detail}`);
}

async function main(): Promise<void> {
	const flags = parseArgs(process.argv.slice(2));
	if (flags.help) {
		console.log(HELP);
		return;
	}
	if (!flags.dryRun && flags.otp == null) {
		console.error("Error: --otp <code> is required (or use --dry-run)");
		process.exit(1);
	}
	if (!flags.dryRun && !flags.yes) {
		console.error("Error: pass --yes to confirm publish (combine with --otp)");
		process.exit(1);
	}

	console.log(`Reading ${PUBLISHABLE.length} publishable packages...`);
	const packages = PUBLISHABLE.map((p) => ({ ...p, pkg: readPkg(p.dir) }));
	for (const { name, pkg } of packages) {
		if (pkg.name !== name) {
			console.error(`Error: expected ${name}, found ${pkg.name} in package.json`);
			process.exit(1);
		}
		if (pkg.private === true) {
			console.error(`Error: ${name} is marked private but is in the publishable list`);
			process.exit(1);
		}
	}

	console.log("Pre-flight checks...\n");
	const failures: Failure[] = [];

	const { failures: lsFailures, version } = checkLockstepVersion(packages);
	failures.push(...lsFailures);
	if (!version) {
		reportFailures(failures);
		process.exit(1);
	}
	console.log(`  [OK] Lockstep version: ${version}`);

	const publishedNames = PUBLISHABLE.map((p) => p.name);
	const crossDepFailures = checkCrossDepRanges(version, publishedNames);
	failures.push(...crossDepFailures);
	console.log(
		crossDepFailures.length === 0
			? "  [OK] Cross-package dep ranges aligned"
			: `  [FAIL] Cross-package dep ranges: ${crossDepFailures.length} mismatch(es)`,
	);

	const cliFailures = checkCliConstants(version);
	failures.push(...cliFailures);
	console.log(
		cliFailures.length === 0
			? "  [OK] CLI scaffold constants (BLOKJS_DEP_RANGE, GITHUB_REPO_RELEASE_TAG)"
			: `  [FAIL] CLI scaffold constants: ${cliFailures.length} mismatch(es)`,
	);

	const tagFailures = checkGitTag(version);
	failures.push(...tagFailures);
	console.log(tagFailures.length === 0 ? `  [OK] Git tag v${version} exists` : `  [FAIL] Git tag v${version}`);

	const treeFailures = checkCleanTree();
	failures.push(...treeFailures);
	console.log(treeFailures.length === 0 ? "  [OK] Working tree clean" : "  [FAIL] Working tree not clean");

	if (failures.length > 0) {
		console.log("\nPre-flight FAILED:");
		reportFailures(failures);
		process.exit(1);
	}

	if (!flags.skipBuild) {
		if (!runStep("Build", "bun", ["run", "build"])) {
			console.error("Build failed");
			process.exit(1);
		}
	}
	if (!flags.skipTests) {
		if (!runStep("Tests", "bunx", ["nx", "run-many", "-t", "test"])) {
			console.error("Tests failed");
			process.exit(1);
		}
	}

	console.log("\nPublish plan:");
	for (const { dir, name } of PUBLISHABLE) {
		console.log(`  ${name.padEnd(28)} (${dir}) -> ${version}`);
	}

	if (flags.dryRun) {
		console.log("\nDry run complete. No packages were published.");
		return;
	}

	const otp = flags.otp;
	if (otp == null) throw new Error("unreachable");
	console.log(`\nPublishing 8 packages with OTP ${otp[0]}*****...`);

	const succeeded: string[] = [];
	const skipped: string[] = [];
	const failed: { name: string; output: string }[] = [];
	for (const { dir, name } of PUBLISHABLE) {
		process.stdout.write(`  ${name.padEnd(28)} `);
		const { ok, alreadyPublished, output } = publishOne(dir, otp);
		if (alreadyPublished) {
			console.log("ALREADY PUBLISHED");
			skipped.push(name);
		} else if (ok) {
			console.log("OK");
			succeeded.push(name);
		} else {
			console.log("FAIL");
			failed.push({ name, output });
		}
	}

	console.log(
		`\nPublish complete: ${succeeded.length} new, ${skipped.length} already-published, ${failed.length} failed.`,
	);
	if (failed.length > 0) {
		console.log("\nFailures:");
		for (const f of failed) {
			console.log(`  ${f.name}:`);
			for (const line of f.output.split("\n").slice(0, 10)) console.log(`    ${line}`);
		}
		console.log("\nRe-run with a fresh OTP. Already-published versions skip benignly.");
		process.exit(1);
	}

	console.log("\nAll 8 packages published. Run the post-publish smoke test:");
	console.log("  cd /tmp && npx blokctl@latest create project --name myapp ...");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
