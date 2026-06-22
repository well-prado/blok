/**
 * Pure, file-system-free helpers for adding/removing a runtime from an
 * existing project's `.blok/config.json`, `.env.local`, `supervisord.conf`,
 * and `.gitignore`. Kept side-effect-free so they're trivially unit-testable;
 * the `runtime add` / `runtime remove` commands do the file I/O around them.
 *
 * The scaffold's generators (`generateRuntimeEnvVars`, `generateSupervisordConfig`)
 * emit a whole block from scratch, which is correct for `create project` but
 * would clobber sibling config on an incremental add/remove. These helpers
 * regenerate only the blokctl-managed runtime sections, leaving everything
 * else (triggers, user-authored env vars, trigger supervisord programs) intact.
 */

import {
	type ProjectConfig,
	type RuntimeConfig,
	generateRuntimeEnvVars,
	generateSupervisordConfig,
} from "./runtime-setup.js";

/** The blokctl-managed env header, matched exactly when rewriting the block. */
const RUNTIME_ENV_HEADER = "# Runtimes (auto-configured by blokctl)";

/** Add or replace a runtime in the config map. Preserves triggers + other runtimes. Pure. */
export function withRuntime(config: ProjectConfig, rc: RuntimeConfig): ProjectConfig {
	return { ...config, runtimes: { ...(config.runtimes ?? {}), [rc.kind]: rc } };
}

/**
 * Remove a runtime by kind. The `runtimes` key becomes `undefined` (and is thus
 * dropped by `JSON.stringify`) when this was the last one. Pure.
 */
export function withoutRuntime(config: ProjectConfig, kind: string): ProjectConfig {
	if (!config.runtimes || !(kind in config.runtimes)) return config;
	const runtimes = Object.fromEntries(Object.entries(config.runtimes).filter(([k]) => k !== kind));
	return { ...config, runtimes: Object.keys(runtimes).length === 0 ? undefined : runtimes };
}

/**
 * Rewrite the blokctl-managed runtime block inside a `.env.local` string so it
 * exactly reflects `runtimes`. Strips the managed header, every
 * `RUNTIME_<K>_(HOST|PORT|GRPC_PORT)` line, and `BLOK_TRANSPORT` (wherever they
 * sit — robust to manual edits), then appends a freshly generated block. When
 * `runtimes` is empty the block is removed entirely. Pure.
 */
export function rewriteRuntimeEnvBlock(envContent: string, runtimes: RuntimeConfig[]): string {
	const isManaged = (line: string): boolean =>
		line.trim() === RUNTIME_ENV_HEADER ||
		/^RUNTIME_[A-Z0-9]+_(HOST|PORT|GRPC_PORT)=/.test(line) ||
		/^BLOK_TRANSPORT=/.test(line);

	const kept = envContent
		.split("\n")
		.filter((line) => !isManaged(line))
		.join("\n")
		.replace(/\n+$/, "");

	const block = generateRuntimeEnvVars(runtimes); // "\n# Runtimes…\n…" or ""
	if (!block) return kept.length > 0 ? `${kept}\n` : "";
	return `${kept}\n${block}\n`;
}

/**
 * Rewrite the runtime `[program:*_runtime]` blocks inside a `supervisord.conf`
 * string so they exactly reflect `runtimes`. Keeps `[supervisord]` and every
 * trigger program (`[program:*_trigger]`) untouched. Pure.
 */
export function rewriteSupervisordRuntimes(supervisordContent: string, runtimes: RuntimeConfig[]): string {
	const out: string[] = [];
	let skipping = false;
	for (const line of supervisordContent.split("\n")) {
		if (/^\[program:[\w-]+_runtime\]/.test(line)) {
			skipping = true; // drop this runtime program block
			continue;
		}
		if (/^\[/.test(line)) skipping = false; // any other section header ends the skip
		if (!skipping) out.push(line);
	}
	const kept = out.join("\n").replace(/\n+$/, "");
	const block = generateSupervisordConfig(runtimes); // "\n[program:…_runtime]\n…" or ""
	return block ? `${kept}\n${block}\n` : `${kept}\n`;
}

/** Build-artifact globs that should never be committed for any runtime. */
const RUNTIME_GITIGNORE_GLOBS = [
	".blok/runtimes/**/bin/",
	".blok/runtimes/**/obj/",
	".blok/runtimes/**/target/",
	".blok/runtimes/**/__pycache__/",
	".blok/runtimes/**/python3_runtime/",
	".blok/runtimes/**/vendor/",
];

/**
 * Ensure the runtime build-artifact ignores are present in a `.gitignore`
 * string (idempotent — only appends what's missing). Pure. A no-op when the
 * whole `.blok/` directory is already ignored.
 */
export function ensureRuntimeGitignore(gitignoreContent: string): string {
	// If `.blok/` is ignored wholesale, the artifact globs are redundant.
	if (/^\.blok\/\s*$/m.test(gitignoreContent)) return gitignoreContent;
	const missing = RUNTIME_GITIGNORE_GLOBS.filter((glob) => !gitignoreContent.includes(glob));
	if (missing.length === 0) return gitignoreContent;
	const base = gitignoreContent.replace(/\n+$/, "");
	return `${base}\n\n# Blok runtime build artifacts (managed by blokctl)\n${missing.join("\n")}\n`;
}
