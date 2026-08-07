import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Deterministic `.env` loading, in ONE place.
 *
 * Before this, Blok relied entirely on Bun's implicit dotenv loading — which
 * means the exact same entrypoint run under Node (`node dist/index.js`, every
 * container image, every consumer harness) loaded nothing at all, and the
 * loading order was whatever the runtime happened to do. Harnesses worked
 * around it by holding credentials in shell memory, so a restart became a
 * re-provision instead of a keystroke.
 *
 * ### Order and precedence (highest wins)
 *
 * 1. Variables already present in `process.env` (real shell env, `blokctl dev`
 *    spawn env, container env). **Never** overwritten.
 * 2. `.env.local` — machine-local overrides, git-ignored. Skipped when
 *    `NODE_ENV=test`, matching Bun and dotenv-cli, so a developer's local
 *    credentials can't leak into a test run.
 * 3. `.env` — committed defaults.
 *
 * This matches Bun's own precedence, so a project behaves identically under
 * `bun run` and `node`. Under Bun the loader is effectively a no-op: Bun has
 * already populated `process.env`, and rule 1 leaves those values alone.
 *
 * Opt out with `BLOK_DOTENV_DISABLED=1`.
 *
 * ponytail: ~40-line parser instead of a `dotenv` dependency — Blok has no
 * runtime dep on it and the supported syntax below covers every `.env` the CLI
 * writes. Upgrade path: swap the body for `process.loadEnvFile()` once the
 * minimum supported Bun ships it (Bun 1.3 does not).
 */

let loaded = false;

/**
 * Parse `.env` text. Supports `KEY=value`, `export KEY=value`, `#` comments,
 * blank lines, and single/double-quoted values (escapes expanded in
 * double-quoted values only, like every other dotenv implementation).
 */
export function parseDotenv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		let key = line.slice(0, eq).trim();
		if (key.startsWith("export ")) key = key.slice(7).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue;

		let value = line.slice(eq + 1).trim();
		if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) {
			value = value.slice(1, -1).replaceAll("\\n", "\n").replaceAll("\\r", "\r").replaceAll('\\"', '"');
		} else if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) {
			value = value.slice(1, -1);
		} else {
			// Unquoted values keep everything up to an unescaped ` #` comment.
			const comment = value.search(/\s#/);
			if (comment !== -1) value = value.slice(0, comment).trim();
		}
		out[key] = value;
	}
	return out;
}

/**
 * Load `.env.local` then `.env` from `cwd` into `process.env`, filling in only
 * keys that are not already set. Idempotent — repeated calls are no-ops unless
 * `force` is passed (tests).
 *
 * @returns the file names actually applied, in precedence order.
 */
export function loadDotenvFiles(cwd: string = process.cwd(), opts: { force?: boolean } = {}): string[] {
	if (loaded && !opts.force) return [];
	loaded = true;
	if (process.env.BLOK_DOTENV_DISABLED === "1") return [];

	const files = process.env.NODE_ENV === "test" ? [".env"] : [".env.local", ".env"];
	const applied: string[] = [];

	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(join(cwd, file), "utf8");
		} catch {
			continue; // absent is the normal case
		}
		let used = false;
		for (const [key, value] of Object.entries(parseDotenv(text))) {
			if (process.env[key] !== undefined) continue;
			process.env[key] = value;
			used = true;
		}
		if (used) applied.push(file);
	}
	return applied;
}

/** Test seam — reset the once-guard. */
export function resetDotenvLoader(): void {
	loaded = false;
}
