/**
 * Bundle the scaffold's repo assets into dist/scaffold-repo/ at build time,
 * preserving the repo-relative layout so every `${repoSource}/…` path in
 * create/project.ts and runtime-setup.ts works verbatim against the bundle.
 *
 * This is what lets a published blokctl scaffold WITHOUT `git clone`-ing the
 * repo — the clone required network + a public repo and broke `create` for
 * every machine without repo access (caught by the v1.3.0 post-publish gate).
 *
 * Keep the asset list in lock-step with the `${repoSource}/…` reads in
 * create/project.ts, services/obs-setup.ts, and services/runtime-setup.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const CLI_DIR = path.resolve(import.meta.dir, "..");
const REPO_ROOT = path.resolve(CLI_DIR, "../..");
const DEST = path.join(CLI_DIR, "dist", "scaffold-repo");

/** Repo-relative dirs the scaffold reads. */
const ASSET_DIRS = [
	"triggers", // trigger sources + per-trigger project templates
	"workflows", // JSON/YAML/TOML example workflows
	"examples/ts-workflows", // TS example workflows (--examples)
	"sdk", // public/sdk browser client
	"infra/development", // dev docker-compose + pg seed (.dat needed by --examples)
	"infra/milvus",
	"infra/metrics", // observability stack tiers
	"sdks", // runtime SDK sources vendored into .blok/runtimes/<lang>
];

/** Build junk that must never ship (per-language build output + deps). */
const EXCLUDE = new Set([
	"node_modules",
	"dist",
	"target", // rust/java build output
	"vendor", // php composer
	".venv",
	"__pycache__",
	"obj", // dotnet
	"bin", // dotnet/go build output
	".gradle",
	"coverage",
	".nx",
]);

function copyDir(src: string, dest: string): void {
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		if (EXCLUDE.has(entry.name)) continue;
		const s = path.join(src, entry.name);
		const d = path.join(dest, entry.name);
		if (entry.isDirectory()) copyDir(s, d);
		else if (entry.isFile()) fs.copyFileSync(s, d);
		// symlinks skipped — none of the asset dirs should contain any
	}
}

fs.rmSync(DEST, { recursive: true, force: true });
for (const rel of ASSET_DIRS) {
	const src = path.join(REPO_ROOT, rel);
	if (!fs.existsSync(src)) {
		console.error(`bundle-scaffold-assets: missing asset dir ${rel} — asset list out of date?`);
		process.exit(1);
	}
	copyDir(src, path.join(DEST, rel));
}

const sizeKb = (() => {
	let total = 0;
	const walk = (dir: string): void => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else total += fs.statSync(p).size;
		}
	};
	walk(DEST);
	return Math.round(total / 1024);
})();
console.log(`bundle-scaffold-assets: ${ASSET_DIRS.length} dirs → dist/scaffold-repo (${sizeKb}KB)`);
