import type { ScannedWorkflow } from "./scanWorkflows";

/**
 * WorkflowRouter — builds the explicit route table from scanned workflows
 * plus any manually-registered TS workflows from `Workflows.ts`.
 *
 * **Routing model (v0.4+):** `trigger.http.path` is REQUIRED. Each
 * workflow declares its own URL explicitly. Filename-derived URLs and
 * the legacy `/<workflow-key>/<sub>` catch-all are gone — except behind
 * the deprecation flag.
 *
 * **Legacy escape hatch:** set `BLOK_ROUTING_LEGACY=1` (or `=true`) to
 * keep the v0.3 behavior — workflows without an explicit `path` fall
 * back to the file-derived URL (for scanned JSON workflows) or the
 * `/<workflow-key>/<sub>` catch-all (for manual TS registrations). A
 * deprecation warning is emitted at boot for every affected workflow.
 * This flag will be removed in v0.5.
 *
 * **Migration**: run `blokctl migrate paths` to write explicit
 * `trigger.http.path` into every JSON workflow that's missing it.
 *
 * **Collision detection** (at boot, fail loudly):
 * - Exact duplicate `(method, path)` pair → throw with both source paths.
 * - Method `ANY` shadowing a more-specific method on the same path → throw.
 * - Param vs literal at the same depth → log a warning (Hono routes
 *   literals first; this is usually intended but worth surfacing).
 */

const LEGACY_FLAG_ENV = "BLOK_ROUTING_LEGACY";

function isLegacyRoutingEnabled(): boolean {
	const raw = process.env[LEGACY_FLAG_ENV];
	return raw === "1" || raw === "true";
}

/**
 * Detect whether a workflow object is flagged as middleware. Reads BOTH the
 * root `middleware` field (JSON workflows, raw object literals, legacy
 * `Workflow()` builders that carry it on the root) AND `_config.middleware`
 * (the v2 `workflow({ middleware: true })` builder, whose flag lives on the
 * nested `_config`). Only the literal `true` is the marker — matching
 * `WorkflowV2Schema.middleware` (`z.literal(true)`) and the normalizer's
 * `=== true` check.
 *
 * Used by {@link buildRouteTable} to exclude middleware workflows from the
 * route table (so they are never exposed as public Hono routes, even with a
 * stray trigger block — Bug 01 / F17) and by `HttpTrigger` to register them
 * with `isMiddleware: true`.
 */
export function readMiddlewareFlag(wf: unknown): boolean {
	if (!wf || typeof wf !== "object") return false;
	const w = wf as { middleware?: unknown; _config?: { middleware?: unknown } };
	return w.middleware === true || w._config?.middleware === true;
}

/** A single registered route entry, ready for `app.<method>(path, handler)`. */
export interface RouteEntry {
	readonly method: string;
	readonly path: string;
	readonly workflowKey: string;
	readonly source: string;
	readonly kind: "ts" | "json";
	/** The workflow object (raw, pre-normalization). */
	readonly workflow: unknown;
}

/** Manual TS workflow registration (today's `Workflows.ts` map). */
export interface ManualRegistration {
	readonly key: string;
	readonly workflow: unknown;
}

/** Errors raised during route-table construction. */
export class RouteCollisionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RouteCollisionError";
	}
}

/**
 * Structured collision report emitted via the `onCollision` callback
 * when `buildRouteTable` is invoked in tolerant mode. Keyed by the
 * `(method, path)` pair that two or more workflows claim.
 *
 * - `kind: "duplicate"` — exact same method+path collision.
 * - `kind: "any-shadows-specific"` — an `ANY` route was registered after
 *   a more-specific method on the same path (or vice versa).
 *
 * Tolerant mode (callback passed): the SECOND-and-later offending
 * workflow is dropped, the first stays. Strict mode (no callback,
 * back-compat): the function throws on the first collision, just like
 * before.
 */
export interface RouteCollision {
	readonly kind: "duplicate" | "any-shadows-specific";
	readonly method: string;
	readonly path: string;
	/** The workflow source that "wins" (already in the table). */
	readonly winnerSource: string;
	/** The workflow source that was dropped on this collision. */
	readonly droppedSource: string;
	/** Human-readable explanation suitable for logging + UI surfacing. */
	readonly message: string;
}

/**
 * Thrown when a workflow is missing an explicit `trigger.http.path`
 * and the legacy escape hatch (`BLOK_ROUTING_LEGACY=1`) is not set.
 *
 * v0.4 made explicit paths required. Run `blokctl migrate paths` to
 * auto-fill missing paths from the file location, OR set the legacy
 * flag to opt back into the v0.3 behavior (will be removed in v0.5).
 */
export class MissingExplicitPathError extends Error {
	constructor(source: string, hint: string) {
		super(
			`[blok][routing] workflow at ${source} is missing \`trigger.http.path\`. ${hint}\nFix options:\n  1. Add \`trigger.http.path\` to the workflow file.\n  2. Run \`blokctl migrate paths\` to auto-fill from the file location.\n  3. Set BLOK_ROUTING_LEGACY=1 to opt into the deprecated v0.3 behavior (removed in v0.5).`,
		);
		this.name = "MissingExplicitPathError";
	}
}

/**
 * Build the route table from a mix of scanned workflows and manually-
 * registered TS workflows.
 *
 * @returns the canonical list of routes ready for explicit registration.
 *   Iteration order is stable (scan order, then manual registrations).
 */
export function buildRouteTable(
	scanned: readonly ScannedWorkflow[],
	manual: readonly ManualRegistration[] = [],
	options: {
		onWarning?: (msg: string) => void;
		/**
		 * When provided, route collisions are reported via this callback
		 * and the offending entry is SKIPPED instead of throwing. Tolerant
		 * mode — used by the HTTP trigger at boot so a single bad workflow
		 * doesn't drop the entire route table (which then falls back to the
		 * legacy catch-all and breaks every URL). Without this callback,
		 * collisions throw `RouteCollisionError` exactly like before.
		 */
		onCollision?: (collision: RouteCollision) => void;
	} = {},
): RouteEntry[] {
	const out: RouteEntry[] = [];
	const seen = new Map<string, RouteEntry>();
	const legacyMode = isLegacyRoutingEnabled();
	const tolerant = typeof options.onCollision === "function";

	for (const sw of scanned) {
		// Bug 01 / F17 — a middleware workflow is NEVER a public route, even if
		// it (incorrectly) carries an `http` trigger block. Exclude it here so
		// the route table stays semantically pure; HttpTrigger registers it with
		// `isMiddleware: true` separately.
		if (readMiddlewareFlag(sw.workflow)) continue;
		const triggerCfg = extractHttpTrigger(sw.workflow);
		if (!triggerCfg) continue; // not http-triggered → not a routed workflow
		const method = normalizeMethod(triggerCfg.method);
		const explicitPath = typeof triggerCfg.path === "string" ? triggerCfg.path : undefined;

		let finalPath: string;
		if (explicitPath) {
			finalPath = explicitPath;
		} else if (legacyMode) {
			// Deprecated path: fall back to the file-derived URL and warn.
			finalPath = sw.defaultPath;
			options.onWarning?.(
				`[blok][routing] DEPRECATED — workflow at ${sw.source} has no explicit \`trigger.http.path\`. Using file-derived URL "${finalPath}". Run \`blokctl migrate paths\` to write the explicit path. The BLOK_ROUTING_LEGACY flag will be removed in v0.5.`,
			);
		} else {
			throw new MissingExplicitPathError(
				sw.source,
				`Would have derived "${sw.defaultPath}" from the file location, but explicit-path-only routing is enabled (default since v0.4).`,
			);
		}

		const workflowKey = sw.name ?? deriveKeyFromPath(sw.source);
		const entry: RouteEntry = {
			method,
			path: finalPath,
			workflowKey,
			source: sw.source,
			kind: sw.kind,
			workflow: sw.workflow,
		};
		const collision = detectCollision(seen, entry);
		if (handleCollision(collision, tolerant, options.onCollision)) continue;
		out.push(entry);
		seen.set(routeKey(entry), entry);
	}

	for (const mr of manual) {
		// Bug 01 — a TS middleware (`workflow({ middleware: true })`, flag on
		// `_config`) is excluded from the route table too, even with a dummy
		// trigger. HttpTrigger's manual-middleware pass registers it instead.
		if (readMiddlewareFlag(mr.workflow)) continue;
		const triggerCfg = extractHttpTrigger(mr.workflow);
		if (!triggerCfg) continue;
		const method = normalizeMethod(triggerCfg.method);
		const explicitPath = typeof triggerCfg.path === "string" ? triggerCfg.path : undefined;

		// Manual TS workflows: explicit path is REQUIRED in v0.4+. Under
		// legacy mode, we silently skip un-pathed manual entries so they
		// can still respond via the catch-all dispatch in HttpTrigger
		// (`/<workflow-key>/<sub>`); a deprecation warning is emitted
		// once per workflow.
		if (!explicitPath) {
			if (legacyMode) {
				options.onWarning?.(
					`[blok][routing] DEPRECATED — manual workflow Workflows.ts[${JSON.stringify(mr.key)}] has no explicit \`trigger.http.path\`. Falling through to catch-all dispatch /${mr.key}/<sub-path>. The BLOK_ROUTING_LEGACY flag will be removed in v0.5.`,
				);
				continue;
			}
			throw new MissingExplicitPathError(
				`Workflows.ts[${JSON.stringify(mr.key)}]`,
				"Manual TS workflow registrations also require an explicit `trigger.http.path` in v0.4+.",
			);
		}

		const entry: RouteEntry = {
			method,
			path: explicitPath,
			workflowKey: mr.key,
			source: `Workflows.ts[${JSON.stringify(mr.key)}]`,
			kind: "ts",
			workflow: mr.workflow,
		};
		const collision = detectCollision(seen, entry);
		if (handleCollision(collision, tolerant, options.onCollision)) continue;
		out.push(entry);
		seen.set(routeKey(entry), entry);
	}

	// Param-vs-literal warnings (non-fatal).
	warnAmbiguousLiterals(out, options.onWarning);

	// Sort by specificity so explicit literal paths register BEFORE catch-all
	// param paths. Hono (like Express) matches in registration order when
	// multiple routes overlap; without this sort, a workflow with `path: "/:id"`
	// scanned alphabetically before `path: "/users"` would shadow the literal.
	// Stable sort preserves scan order within the same specificity bucket.
	return sortBySpecificity(out);
}

/**
 * Score a path by route specificity (higher = more specific). Used by
 * {@link buildRouteTable} so explicit literal routes are registered before
 * parameterized catch-alls.
 *
 * Heuristic: tally each segment.
 *   - literal segment      → +100
 *   - `:param`             → +10
 *   - `:param?` (optional) → +1
 *   - `*` (Hono wildcard)  → +0
 * Tie-break favours longer paths (more segments = more specific).
 *
 * Exported for tests; internal otherwise.
 */
export function scorePathSpecificity(path: string): number {
	const segs = path.split("/").filter(Boolean);
	let score = 0;
	for (const s of segs) {
		if (s === "*" || s.startsWith("*")) continue;
		if (s.startsWith(":")) {
			score += s.endsWith("?") ? 1 : 10;
		} else if (s.startsWith("{") || s.includes(":")) {
			// Hono regex syntax `{:param}` or named params with regex.
			score += 10;
		} else {
			score += 100;
		}
	}
	// Tie-break: longer paths beat shorter ones with the same score base.
	return score * 1000 + segs.length;
}

function sortBySpecificity(routes: readonly RouteEntry[]): RouteEntry[] {
	// Stable sort: routes with equal specificity keep their scan order
	// (the JS spec guarantees Array.prototype.sort is stable as of ES2019).
	return [...routes].sort((a, b) => scorePathSpecificity(b.path) - scorePathSpecificity(a.path));
}

// ---------------------------------------------------------------------------

function extractHttpTrigger(wf: unknown): { method?: string; path?: string } | null {
	if (!wf || typeof wf !== "object") return null;
	const obj = wf as Record<string, unknown>;
	const direct = obj.trigger;
	const config = obj._config as Record<string, unknown> | undefined;
	const trigger = (direct ?? config?.trigger) as Record<string, unknown> | undefined;
	if (!trigger || typeof trigger !== "object") return null;
	const http = trigger.http as Record<string, unknown> | undefined;
	if (!http || typeof http !== "object") return null;
	return {
		method: typeof http.method === "string" ? http.method : undefined,
		path: typeof http.path === "string" ? http.path : undefined,
	};
}

function normalizeMethod(raw: string | undefined): string {
	if (!raw) return "ANY";
	if (raw === "*") return "ANY";
	return raw.toUpperCase();
}

function routeKey(entry: RouteEntry): string {
	return `${entry.method} ${entry.path}`;
}

function detectCollision(seen: Map<string, RouteEntry>, entry: RouteEntry): RouteCollision | null {
	// Exact duplicate.
	const exact = seen.get(routeKey(entry));
	if (exact) {
		return {
			kind: "duplicate",
			method: entry.method,
			path: entry.path,
			winnerSource: exact.source,
			droppedSource: entry.source,
			message: `Two workflows claim ${entry.method} ${entry.path}:\n  - ${exact.source}\n  - ${entry.source}\nSet an explicit \`trigger.http.path\` on one to disambiguate, or remove the duplicate.`,
		};
	}

	// `ANY` shadowing more-specific methods on the same path, or vice versa.
	if (entry.method === "ANY") {
		for (const [, e] of seen) {
			if (e.path === entry.path && e.method !== "ANY") {
				return {
					kind: "any-shadows-specific",
					method: entry.method,
					path: entry.path,
					winnerSource: e.source,
					droppedSource: entry.source,
					message: `ANY ${entry.path} (${entry.source}) shadows the existing route ${e.method} ${e.path} (${e.source}). Either narrow the ANY workflow's method or remove the more-specific one.`,
				};
			}
		}
	} else {
		const anyKey = `ANY ${entry.path}`;
		const anyExisting = seen.get(anyKey);
		if (anyExisting) {
			return {
				kind: "any-shadows-specific",
				method: entry.method,
				path: entry.path,
				winnerSource: anyExisting.source,
				droppedSource: entry.source,
				message: `${entry.method} ${entry.path} (${entry.source}) is shadowed by an existing ANY route (${anyExisting.source}). Either narrow the ANY workflow's method or remove this one.`,
			};
		}
	}

	return null;
}

/**
 * Strict-mode helper used by both loop arms in `buildRouteTable`.
 * In tolerant mode, the caller reports + skips; in strict mode this
 * throws to preserve the v0.4 behaviour (and the test suite).
 */
function handleCollision(
	collision: RouteCollision | null,
	tolerant: boolean,
	onCollision: ((c: RouteCollision) => void) | undefined,
): boolean {
	if (!collision) return false;
	if (tolerant) {
		onCollision?.(collision);
		return true;
	}
	throw new RouteCollisionError(collision.message);
}

function warnAmbiguousLiterals(routes: readonly RouteEntry[], onWarning: ((msg: string) => void) | undefined): void {
	if (!onWarning) return;
	const byMethod = new Map<string, RouteEntry[]>();
	for (const r of routes) {
		const arr = byMethod.get(r.method) ?? [];
		arr.push(r);
		byMethod.set(r.method, arr);
	}
	for (const arr of byMethod.values()) {
		const segCount = new Map<number, RouteEntry[]>();
		for (const r of arr) {
			const segs = r.path.split("/").filter(Boolean).length;
			const list = segCount.get(segs) ?? [];
			list.push(r);
			segCount.set(segs, list);
		}
		for (const list of segCount.values()) {
			const literals = list.filter((r) => !r.path.includes("/:"));
			const params = list.filter((r) => r.path.includes("/:"));
			if (literals.length > 0 && params.length > 0) {
				for (const lit of literals) {
					for (const par of params) {
						onWarning(
							`${par.method} ${par.path} (param) and ${lit.method} ${lit.path} (literal) both registered. Hono routes literal first — confirm this is intended.`,
						);
					}
				}
			}
		}
	}
}

function deriveKeyFromPath(filepath: string): string {
	const filename = filepath.replace(/\\/g, "/").split("/").pop() ?? "";
	return filename.replace(/\.(ts|js|json)$/i, "");
}
