import type { ScannedWorkflow } from "./scanWorkflows";

/**
 * WorkflowRouter — builds the explicit route table from scanned workflows
 * plus any manually-registered TS workflows from `Workflows.ts`.
 *
 * **Source priority for the URL path:**
 * 1. `trigger.http.path` set explicitly on the workflow → wins.
 * 2. The default path derived from the file location → fallback.
 * 3. The manual-registration key from `Workflows.ts` (legacy `/<key>` URL)
 *    → only used when the workflow is NOT scanned (e.g. it's exported but
 *    not present on disk under the scan roots). For v2 migration this is
 *    the path of last resort.
 *
 * **Collision detection** (at boot, fail loudly):
 * - Exact duplicate `(method, path)` pair → throw with both source paths.
 * - Method `ANY` shadowing a more-specific method on the same path → throw.
 * - Param vs literal at the same depth → log a warning (Hono routes
 *   literals first; this is usually intended but worth surfacing).
 */

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
 * Build the route table from a mix of scanned workflows and manually-
 * registered TS workflows.
 *
 * @returns the canonical list of routes ready for explicit registration.
 *   Iteration order is stable (scan order, then manual registrations).
 */
export function buildRouteTable(
	scanned: readonly ScannedWorkflow[],
	manual: readonly ManualRegistration[] = [],
	options: { onWarning?: (msg: string) => void } = {},
): RouteEntry[] {
	const out: RouteEntry[] = [];
	const seen = new Map<string, RouteEntry>();

	for (const sw of scanned) {
		const triggerCfg = extractHttpTrigger(sw.workflow);
		if (!triggerCfg) continue; // not http-triggered → not a routed workflow
		const method = normalizeMethod(triggerCfg.method);
		const explicitPath = typeof triggerCfg.path === "string" ? triggerCfg.path : undefined;
		const finalPath = explicitPath ?? sw.defaultPath;
		const workflowKey = sw.name ?? deriveKeyFromPath(sw.source);
		const entry: RouteEntry = {
			method,
			path: finalPath,
			workflowKey,
			source: sw.source,
			kind: sw.kind,
			workflow: sw.workflow,
		};
		assertNoCollision(seen, entry);
		out.push(entry);
		seen.set(routeKey(entry), entry);
	}

	for (const mr of manual) {
		const triggerCfg = extractHttpTrigger(mr.workflow);
		if (!triggerCfg) continue;
		const method = normalizeMethod(triggerCfg.method);
		const explicitPath = typeof triggerCfg.path === "string" ? triggerCfg.path : undefined;
		// Manual registrations: if the author set an explicit path, use it.
		// Otherwise we leave them to the legacy catch-all (no explicit
		// registration produced). This preserves v1 URL behaviour
		// (`/<key>/<sub-path>`) for un-migrated workflows.
		if (!explicitPath) continue;
		const entry: RouteEntry = {
			method,
			path: explicitPath,
			workflowKey: mr.key,
			source: `Workflows.ts[${JSON.stringify(mr.key)}]`,
			kind: "ts",
			workflow: mr.workflow,
		};
		assertNoCollision(seen, entry);
		out.push(entry);
		seen.set(routeKey(entry), entry);
	}

	// Param-vs-literal warnings (non-fatal).
	warnAmbiguousLiterals(out, options.onWarning);

	return out;
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

function assertNoCollision(seen: Map<string, RouteEntry>, entry: RouteEntry): void {
	// Exact duplicate.
	const exact = seen.get(routeKey(entry));
	if (exact) {
		throw new RouteCollisionError(
			`Two workflows claim ${entry.method} ${entry.path}:\n  - ${exact.source}\n  - ${entry.source}\nSet an explicit \`trigger.http.path\` on one to disambiguate, or remove the duplicate.`,
		);
	}

	// `ANY` shadowing more-specific methods on the same path, or vice versa.
	if (entry.method === "ANY") {
		for (const [k, e] of seen) {
			if (e.path === entry.path && e.method !== "ANY") {
				throw new RouteCollisionError(
					`ANY ${entry.path} (${entry.source}) shadows the existing route ${e.method} ${e.path} (${e.source}). Either narrow the ANY workflow's method or remove the more-specific one.`,
				);
			}
			void k;
		}
	} else {
		const anyKey = `ANY ${entry.path}`;
		const anyExisting = seen.get(anyKey);
		if (anyExisting) {
			throw new RouteCollisionError(
				`${entry.method} ${entry.path} (${entry.source}) is shadowed by an existing ANY route (${anyExisting.source}). Either narrow the ANY workflow's method or remove this one.`,
			);
		}
	}
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
