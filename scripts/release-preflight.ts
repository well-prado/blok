/**
 * Pure pre-flight checks for `release.ts` — no filesystem, npm, or git access,
 * so they unit-test against synthetic `package.json` inputs (#381). `release.ts`
 * reads the real files and feeds them in.
 *
 * ## Floating `@blokjs/core` (#380)
 *
 * The publishable set is mostly LOCKSTEP: `trigger-http` imports four sibling
 * triggers by exact range and the CLI scaffold co-versions them, so they must
 * ship as one version. `@blokjs/core` is the exception — it's the leaf author
 * barrel (nothing internal depends on it; it re-exports the engine), so it
 * FLOATS: it can publish a new (minor) version without dragging the rest. The
 * checks below validate a hybrid: one lockstep version for everything except
 * core, plus core's own version, with cross-package dep ranges resolved against
 * whichever applies.
 */

/** A package.json subset the checks read. */
export interface MinimalPkg {
	name?: string;
	version?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

export interface Failure {
	category: string;
	detail: string;
}

/**
 * Packages that version INDEPENDENTLY of the lockstep surface (#380). Keep this
 * the single source of truth — every check consults it.
 */
export const FLOATING_NAMES: ReadonlySet<string> = new Set(["@blokjs/core"]);

/** The lockstep version is shared by every publishable package EXCEPT the floating ones. */
export function checkLockstepVersion(pkgs: readonly MinimalPkg[]): { failures: Failure[]; version: string | null } {
	const lockstep = pkgs.filter((p) => !(p.name !== undefined && FLOATING_NAMES.has(p.name)));
	const versions = new Set(lockstep.map((p) => p.version));
	if (versions.size === 0) {
		return { failures: [{ category: "version", detail: "no packages parsed" }], version: null };
	}
	if (versions.size > 1) {
		const list = lockstep.map((p) => `${p.name}=${p.version}`).join(", ");
		return { failures: [{ category: "version", detail: `lockstep violated: ${list}` }], version: null };
	}
	return { failures: [], version: [...versions][0] ?? null };
}

/** Map of floating package name → its (independent) version, read from the publishable set. */
export function floatingVersions(pkgs: readonly MinimalPkg[]): Map<string, string> {
	const m = new Map<string, string>();
	for (const p of pkgs) {
		if (p.name !== undefined && p.version !== undefined && FLOATING_NAMES.has(p.name)) m.set(p.name, p.version);
	}
	return m;
}

/**
 * Does a dependency `range` admit `version`? Models the range forms the monorepo
 * actually uses on internal `@blokjs` deps — exact `x.y.z`, caret `^x.y.z`,
 * tilde `~x.y.z` — with real semver upper-bound semantics, so a FLOATED
 * `@blokjs/core` minor bump still satisfies a `^1.1.0` pin while a major bump
 * does not. Any OTHER form (`>=`, `||`, `x`-ranges, hyphen ranges, or a
 * prerelease version/range) is NOT modeled and returns `false` — a CONSERVATIVE
 * reject that surfaces as a loud pre-flight failure rather than a silent pass
 * (#381). Every internal range is plain `^x.y.z`, so the unmodeled path never
 * fires in a real release; the explicit-false stops a hand-written exotic range
 * from sneaking a mismatched version through.
 */
export function rangeIncludesVersion(range: string, version: string): boolean {
	const rm = range.trim().match(/^([\^~]?)(\d+)\.(\d+)\.(\d+)$/);
	const vm = version.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!rm || !vm) return false; // unmodeled range, or a prerelease/build version → conservative reject
	const op = rm[1];
	const [bMaj, bMin, bPat] = [Number(rm[2]), Number(rm[3]), Number(rm[4])];
	const [vMaj, vMin, vPat] = [Number(vm[1]), Number(vm[2]), Number(vm[3])];
	const ge = vMaj > bMaj || (vMaj === bMaj && (vMin > bMin || (vMin === bMin && vPat >= bPat)));
	if (op === "") return vMaj === bMaj && vMin === bMin && vPat === bPat; // exact
	if (op === "^") {
		// Caret upper bound by the leftmost non-zero component:
		//   ^1.2.3 → same major; ^0.2.3 → same 0.minor; ^0.0.3 → exact.
		if (bMaj > 0) return ge && vMaj === bMaj;
		if (bMin > 0) return ge && vMaj === 0 && vMin === bMin;
		return ge && vMaj === 0 && vMin === 0 && vPat === bPat;
	}
	// Tilde: ~x.y.z → >=x.y.z <x.(y+1).0
	return ge && vMaj === bMaj && vMin === bMin;
}

/**
 * Validate that every in-repo dependency on a published package pins a range
 * that admits the version about to ship — resolved against core's floating
 * version for `@blokjs/core`, the lockstep version otherwise. `workspace:*` /
 * `*` are skipped (resolved by the package manager).
 */
export function checkCrossDepRanges(
	lockstepVersion: string,
	floating: ReadonlyMap<string, string>,
	publishedNames: readonly string[],
	pkgs: readonly { rel: string; pkg: MinimalPkg }[],
): Failure[] {
	const failures: Failure[] = [];
	for (const { rel, pkg } of pkgs) {
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
				const expected = floating.get(name) ?? lockstepVersion;
				if (!rangeIncludesVersion(range, expected)) {
					failures.push({
						category: "cross-dep",
						detail: `${rel}:${section}: ${name} has range "${range}" but it ships at ${expected}`,
					});
				}
			}
		}
	}
	return failures;
}

/**
 * Validate the CLI scaffold constants in `project.ts`. The release TAG tracks
 * the lockstep version. `BLOKJS_DEP_RANGE` pins EVERY scaffolded `@blokjs/*`
 * (including the floating core), so it must admit the lockstep version AND every
 * floating version — otherwise a freshly-scaffolded project can't install the
 * version that just shipped.
 */
export function checkCliConstants(
	lockstepVersion: string,
	floating: ReadonlyMap<string, string>,
	projectSrc: string,
): Failure[] {
	const failures: Failure[] = [];
	const tagMatch = projectSrc.match(/GITHUB_REPO_RELEASE_TAG\s*=\s*"(v[^"]+)"/);
	if (!tagMatch) {
		failures.push({ category: "cli-constants", detail: "GITHUB_REPO_RELEASE_TAG not found in project.ts" });
	} else if (tagMatch[1] !== `v${lockstepVersion}`) {
		failures.push({
			category: "cli-constants",
			detail: `GITHUB_REPO_RELEASE_TAG="${tagMatch[1]}" but lockstep is v${lockstepVersion}`,
		});
	}
	const rangeMatch = projectSrc.match(/BLOKJS_DEP_RANGE\s*=\s*"(\^[^"]+)"/);
	if (!rangeMatch) {
		failures.push({ category: "cli-constants", detail: "BLOKJS_DEP_RANGE not found in project.ts" });
	} else {
		const range = rangeMatch[1];
		const mustAdmit = [lockstepVersion, ...floating.values()];
		for (const v of mustAdmit) {
			if (!rangeIncludesVersion(range, v)) {
				failures.push({
					category: "cli-constants",
					detail: `BLOKJS_DEP_RANGE="${range}" does not include ${v}`,
				});
			}
		}
	}
	return failures;
}
