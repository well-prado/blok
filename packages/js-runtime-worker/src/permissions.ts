/**
 * Deno permission generation (ADR 0016 §6).
 *
 * Deno is the only one of the three engines with a native permission boundary,
 * so it is the only one whose launch flags can be derived instead of trusted.
 * The derivation input is the capability manifests the project's nodes declare
 * (ADR 0003) — the same metadata agent policy reads — so a node that never
 * declares `filesystem` never gets `--allow-write`.
 *
 * `--allow-all` is reachable only through an explicit opt-in that prints a
 * diagnostic; it is never the default and never inferred.
 */

import type { CapabilityEffect, CapabilityManifestV1 } from "@blokjs/shared";

export interface DenoPermissionOptions {
	/** gRPC port the worker binds — the only address it needs to listen on. */
	port: number;
	/** Project root the worker reads sources and `node_modules` from. */
	projectRoot: string;
	/** Shared claim-check directory, when `blob-v1` is in use. */
	blobDir?: string | null;
	/** The worker package's own root. Needed when it is a symlink outside the
	 * project (a `file:` dependency in a dev scaffold): Deno checks REAL paths
	 * for explicit filesystem reads, and the worker reads its own
	 * `runtime.proto` at boot. */
	workerRoot?: string | null;
	/** Explicit, diagnosed escape hatch. Never set from inferred capabilities. */
	allowAll?: boolean;
	/**
	 * Operator-supplied outbound network allow-list (`BLOK_DENO_ALLOW_NET`),
	 * e.g. `["api.example.com", "db.internal:5432"]`.
	 *
	 * This is the ONLY way to keep a `network`-declaring project off an
	 * unrestricted `--allow-net`. The capability manifest cannot supply it:
	 * `capabilities` is a free-form identifier list (`network.http`) with no
	 * defined host grammar, so nothing in a manifest names a destination. See
	 * `docs/d/cli/runtime-troubleshooting.mdx`.
	 */
	netAllow?: readonly string[];
}

/** One grant decision, for the diagnostic `blokctl dev` prints at spawn. */
export interface DenoGrant {
	flag: string;
	/** Why the grant exists: the baseline, or the declared effect that earned it. */
	reason: string;
}

/**
 * Baseline every worker needs regardless of what the nodes declare: bind the
 * gRPC port, read the project it serves, read the environment. Everything
 * beyond this must be earned by a declared effect.
 *
 * `--allow-env` is unrestricted rather than an allow-list, deliberately:
 *   - a NODE never reads Deno's environment. `ctx.env` is the projection the
 *     runner sends over the wire (`ExecuteRequest.state.env`), so env access
 *     grants node code no authority it did not already have;
 *   - `@grpc/grpc-js` reads `GRPC_*` variables at module load and Deno throws
 *     `NotCapable: Requires env access to "GRPC_NODE_VERBOSITY"` under a
 *     narrowed list — an allow-list would have to enumerate a transitive
 *     dependency's internals and would break on its next release.
 * Recorded in `docs/d/cli/runtime-troubleshooting.mdx`.
 */
function baselineFlags(options: DenoPermissionOptions): string[] {
	const read = [options.projectRoot];
	if (options.workerRoot && !options.workerRoot.startsWith(options.projectRoot)) read.push(options.workerRoot);
	if (options.blobDir) read.push(options.blobDir);
	return [
		`--allow-net=127.0.0.1:${options.port},localhost:${options.port}`,
		`--allow-read=${read.join(",")}`,
		"--allow-env",
	];
}

/**
 * Least-privilege `--allow-*` flags for a Deno worker serving nodes that
 * declare `effects`, with the reason each grant exists.
 *
 * - `network` widens `--allow-net` beyond the bound port. Scoped to
 *   `options.netAllow` when the operator supplied one; otherwise unrestricted,
 *   because nothing in a capability manifest names a destination host.
 * - `filesystem` / `write` grant `--allow-write` scoped to the project root.
 * - `process` grants `--allow-run`.
 * - `read`, `secret`, `streaming`, `destructive` need no additional Deno
 *   permission; they are Blok-level policy concerns.
 *
 * `--allow-ffi` is never derivable: no effect maps to it, so a Deno worker
 * cannot reach native code unless the operator sets `BLOK_DENO_ALLOW_ALL=1`.
 */
export function denoPermissionGrants(
	effects: readonly CapabilityEffect[],
	options: DenoPermissionOptions,
): DenoGrant[] {
	if (options.allowAll) {
		return [{ flag: "--allow-all", reason: "BLOK_DENO_ALLOW_ALL=1 (explicit opt-out of the permission boundary)" }];
	}
	const set = new Set(effects);
	const base = baselineFlags(options);
	const grants: DenoGrant[] = [
		{ flag: base[0], reason: "baseline: bind the worker's own gRPC port" },
		{ flag: base[1], reason: "baseline: read the project sources and node_modules this worker serves" },
		{ flag: base[2], reason: "baseline: @grpc/grpc-js reads GRPC_* variables at load (see runtime troubleshooting)" },
	];
	if (set.has("network")) {
		const net = options.netAllow?.filter((entry) => entry.trim().length > 0) ?? [];
		grants[0] =
			net.length > 0
				? { flag: `--allow-net=${net.join(",")}`, reason: "effect `network`, scoped by BLOK_DENO_ALLOW_NET" }
				: {
						flag: "--allow-net",
						reason:
							"effect `network` — unrestricted: no manifest field names outbound hosts. Set BLOK_DENO_ALLOW_NET to scope it.",
					};
	}
	if (set.has("filesystem") || set.has("write")) {
		grants.push({ flag: `--allow-write=${options.projectRoot}`, reason: "effect `filesystem`/`write`" });
	}
	if (set.has("process")) {
		grants.push({ flag: "--allow-run", reason: "effect `process`" });
	}
	return grants;
}

/** The flags alone — what actually goes on the Deno command line. */
export function denoPermissionFlags(effects: readonly CapabilityEffect[], options: DenoPermissionOptions): string[] {
	return denoPermissionGrants(effects, options).map((grant) => grant.flag);
}

/** Parse `BLOK_DENO_ALLOW_NET` (comma-separated `host` / `host:port`). */
export function parseNetAllowList(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/** Flags a Deno worker needs merely to LOAD its nodes and report what they
 * declare — the first half of the two-phase boot `blokctl dev` performs. */
export function denoIntrospectionFlags(options: DenoPermissionOptions): string[] {
	return baselineFlags(options);
}

/** Union of the effects declared across a set of node manifests. Nodes with no
 * manifest contribute nothing: absence is not a grant. */
export function declaredEffects(manifests: ReadonlyArray<CapabilityManifestV1 | undefined | null>): CapabilityEffect[] {
	const set = new Set<CapabilityEffect>();
	for (const manifest of manifests) {
		for (const effect of manifest?.effects ?? []) set.add(effect);
	}
	return [...set].sort();
}
