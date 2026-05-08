/**
 * Operator-controlled allowlist for `ctx.env` exposed to user nodes.
 *
 * By default `ctx.env` mirrors `process.env` — every node sees every
 * env var. Operators harden against accidental secret leakage by
 * setting one or both of:
 *
 * - `BLOK_NODE_ENV_ALLOW` — comma-separated exact names. Example:
 *   `BLOK_NODE_ENV_ALLOW=DATABASE_URL,STRIPE_KEY`
 * - `BLOK_NODE_ENV_ALLOW_PREFIX` — comma-separated prefixes. Example:
 *   `BLOK_NODE_ENV_ALLOW_PREFIX=PUBLIC_,SAFE_`
 *
 * When EITHER is set, `ctx.env` becomes a Proxy that returns
 * `undefined` for keys not in the allowlist and excludes them from
 * `Object.keys`/`for...in`/`hasOwnProperty`. When NEITHER is set,
 * `ctx.env` is `process.env` directly (preserves v0.4.x semantics —
 * no breaking change).
 *
 * Set `BLOK_SUPPRESS_ENV_ALLOW_WARNING=1` to silence the boot warning
 * that fires when `BLOK_ENV=production` and no allowlist is configured.
 *
 * The allowlist is parsed on every `getEnvForCtx()` call (creating a
 * Context). Cost is sub-microsecond — strings are small and the
 * Proxy is allocated once per request. Tests can mutate
 * `process.env.BLOK_NODE_ENV_ALLOW` between calls and see the change
 * immediately (no module-load caching).
 */

interface EnvAllowConfig {
	/** Exact-match names. Empty means "no exact-match allowlist". */
	allow: string[];
	/** Prefix matches. Empty means "no prefix-match allowlist". */
	prefixes: string[];
}

function parseList(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

function loadConfig(): EnvAllowConfig | null {
	const allow = parseList(process.env.BLOK_NODE_ENV_ALLOW);
	const prefixes = parseList(process.env.BLOK_NODE_ENV_ALLOW_PREFIX);
	if (allow.length === 0 && prefixes.length === 0) return null;
	return { allow, prefixes };
}

function isAllowed(key: string, config: EnvAllowConfig): boolean {
	if (config.allow.includes(key)) return true;
	for (const p of config.prefixes) {
		if (key.startsWith(p)) return true;
	}
	return false;
}

/**
 * Build a Proxy around `process.env` that hides keys not in the
 * allowlist. Reads of denied keys return `undefined`; iteration via
 * `Object.keys` / `for...in` / `Object.entries` excludes them; `key
 * in env` returns `false`. Writes pass through (operators don't lose
 * the ability for nodes to mutate process.env if they want to — the
 * filter is a read gate, not a sandbox).
 */
function buildProxy(config: EnvAllowConfig): NodeJS.ProcessEnv {
	return new Proxy(process.env, {
		get(target, key: string | symbol): string | undefined {
			if (typeof key !== "string") return undefined;
			return isAllowed(key, config) ? target[key] : undefined;
		},
		has(target, key: string | symbol): boolean {
			if (typeof key !== "string") return false;
			return isAllowed(key, config) && key in target;
		},
		ownKeys(target): ArrayLike<string> {
			return Object.keys(target).filter((k) => isAllowed(k, config));
		},
		getOwnPropertyDescriptor(target, key: string | symbol): PropertyDescriptor | undefined {
			if (typeof key !== "string" || !isAllowed(key, config)) return undefined;
			return Object.getOwnPropertyDescriptor(target, key);
		},
	}) as NodeJS.ProcessEnv;
}

let productionWarningEmitted = false;
function emitProductionWarning(): void {
	if (productionWarningEmitted) return;
	productionWarningEmitted = true;
	if (process.env.BLOK_SUPPRESS_ENV_ALLOW_WARNING === "1") return;
	if (process.env.BLOK_ENV !== "production") return;
	console.warn(
		"[blok] BLOK_ENV=production but neither BLOK_NODE_ENV_ALLOW nor BLOK_NODE_ENV_ALLOW_PREFIX is set. " +
			"Every loaded node sees every env var, including secrets. " +
			"Configure an allowlist to harden the surface, or set " +
			"BLOK_SUPPRESS_ENV_ALLOW_WARNING=1 to silence.",
	);
}

/**
 * Returns the object to assign to `ctx.env`. When no allowlist is
 * configured, returns `process.env` (default-allow). When configured,
 * returns a filtering Proxy. Called by `TriggerBase.createContext`.
 */
export function getEnvForCtx(): NodeJS.ProcessEnv {
	const config = loadConfig();
	if (!config) {
		emitProductionWarning();
		return process.env;
	}
	return buildProxy(config);
}

/** Test-only — clears the once-per-process production warning flag. */
export function _resetEnvAllowlistForTests(): void {
	productionWarningEmitted = false;
}
