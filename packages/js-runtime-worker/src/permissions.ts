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
}

/** Baseline every worker needs regardless of what the nodes declare: bind the
 * gRPC port, read the project it serves, read the environment the runner
 * mirrors in. Everything beyond this must be earned by a declared effect. */
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
 * declare `effects`.
 *
 * - `network` widens `--allow-net` from the bound port to unrestricted: a node
 *   that calls out cannot have its destinations enumerated from the manifest.
 * - `filesystem` / `write` grant `--allow-write` scoped to the project root.
 * - `process` grants `--allow-run`.
 * - `read`, `secret`, `streaming`, `destructive` need no additional Deno
 *   permission; they are Blok-level policy concerns.
 */
export function denoPermissionFlags(effects: readonly CapabilityEffect[], options: DenoPermissionOptions): string[] {
	if (options.allowAll) return ["--allow-all"];
	const set = new Set(effects);
	const flags = baselineFlags(options);
	if (set.has("network")) {
		flags[0] = "--allow-net";
	}
	if (set.has("filesystem") || set.has("write")) {
		flags.push(`--allow-write=${options.projectRoot}`);
	}
	if (set.has("process")) {
		flags.push("--allow-run");
	}
	return flags;
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
