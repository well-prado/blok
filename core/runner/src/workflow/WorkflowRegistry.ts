/**
 * WorkflowRegistry — process-wide name → workflow lookup that the
 * sub-workflow primitive uses to find the child to invoke.
 *
 * Triggers (HTTP, future worker/cron, etc.) feed the registry at boot
 * by calling `registerAll()` with the workflows they discovered. The
 * `SubworkflowNode` then calls `get(name)` at run time to materialize
 * the child.
 *
 * **Lookup contract**: keyed on the workflow's `name:` field — same
 * value the author writes in their workflow definition. Two workflows
 * with the same name from different sources are a load-time error
 * (the registry throws on collision). Re-registration of the same
 * `(name, source)` pair is idempotent (HMR-friendly).
 *
 * **Lifecycle**: singleton, lives for the process. Triggers should
 * `clear()` before re-registering when workflow files change (HMR);
 * the in-repo HTTP trigger does this on every scan.
 *
 * **Authorization** (optional): operators can install a process-wide
 * `(parentName, childName, ctx) => boolean | Promise<boolean>` hook via
 * `setAuthorizeFn()` to gate which parent workflows may invoke which
 * children. Default behavior (no fn set) is allow-all — preserves
 * backwards compatibility. See `docs/d/security/cookbook.mdx` for the
 * multi-tenant patterns.
 *
 * **Why a separate class** (vs reusing the HTTP trigger's RouteEntry[]):
 * - Decoupled from HTTP — worker/cron triggers feed the same registry.
 * - Lookup by `name:` is what authors write; route table is keyed on
 *   `(method, path)` which sub-workflow callers don't know.
 * - Test isolation — `resetInstance()` is cheap.
 */

import type { Context } from "@blokjs/shared";

/**
 * Hook that decides whether a parent workflow may invoke a child via a
 * sub-workflow step. Return `true` (or a promise resolving to `true`) to
 * allow; `false` to deny. The `ctx` is the parent's running context, so
 * the hook can do per-request decisions (e.g. read tenant id from
 * `ctx.req.headers`).
 */
export type WorkflowAuthorizeFn = (parentName: string, childName: string, ctx: Context) => boolean | Promise<boolean>;

export interface RegisteredWorkflow {
	/** The workflow's `name:` field. Sub-workflow steps reference this. */
	readonly name: string;
	/** Filesystem path or `"<inline>"` for builder-constructed workflows. */
	readonly source: string;
	/**
	 * Raw workflow object (pre-normalization). The `SubworkflowNode`
	 * passes this to `Configuration.init(name, opts, preloaded)` which
	 * runs it through `normalizeWorkflow` → resolved nodes.
	 */
	readonly workflow: unknown;
	/**
	 * v0.5 — true when the workflow is registered as middleware (has
	 * `middleware: true` set at the workflow root). Middleware workflows
	 * are not exposed as public routes; they're invoked from another
	 * workflow's `trigger.http.middleware: [...]` array. Looked up via
	 * `getMiddleware(name)`.
	 */
	readonly isMiddleware?: boolean;
}

export class WorkflowRegistry {
	private static instance: WorkflowRegistry | null = null;
	private workflows = new Map<string, RegisteredWorkflow>();
	private authorizeFn: WorkflowAuthorizeFn | null = null;
	/**
	 * v0.5.4 — process-global middleware chain. When set, EVERY workflow
	 * run in this process prepends these middleware to its own chain
	 * (workflow-level `middleware: [...]` and trigger-level
	 * `trigger.http.middleware: [...]` if present). Use this for ops
	 * concerns that must apply uniformly: request-id correlation, audit
	 * logging, OpenTelemetry spans. Unlike workflow- or trigger-level
	 * middleware, global middleware doesn't require touching individual
	 * workflow files.
	 *
	 * **Resolution order** at request time, outer to inner:
	 *   1. Process-global  (this list)
	 *   2. Workflow-level   (`workflow.middleware: [...]`, v0.5.2)
	 *   3. Trigger-level    (`trigger.<kind>.middleware: [...]`, v0.5)
	 *   4. Workflow body    (regular steps)
	 *
	 * **Lifecycle**: write-once-per-process is the typical pattern, but
	 * the setter accepts repeated calls and the LAST call wins. Empty
	 * array clears the global chain. The list itself is stored as a
	 * frozen snapshot so callers reading via `getGlobalMiddleware()`
	 * can't mutate it accidentally.
	 */
	private globalMiddleware: readonly string[] = [];

	static getInstance(): WorkflowRegistry {
		if (!WorkflowRegistry.instance) {
			WorkflowRegistry.instance = new WorkflowRegistry();
		}
		return WorkflowRegistry.instance;
	}

	/** Test-only — drop the singleton so suites start fresh. */
	static resetInstance(): void {
		WorkflowRegistry.instance = null;
	}

	/**
	 * Install a process-wide authorize hook for sub-workflow composition.
	 * Pass `null` to clear (default behavior is allow-all). The hook fires
	 * on every sub-workflow invocation, before the child is materialized.
	 *
	 * Multi-tenant operators typically read a tenant id off `ctx` and
	 * consult an allow-list. The synchronous variant is fine for
	 * in-memory lookups; return a promise if the decision needs an
	 * external store.
	 *
	 * @example
	 * ```ts
	 * WorkflowRegistry.getInstance().setAuthorizeFn((parent, child, ctx) => {
	 *   const tenant = ctx.req.headers["x-tenant"];
	 *   return tenantAllowList[tenant]?.includes(child) ?? false;
	 * });
	 * ```
	 */
	setAuthorizeFn(fn: WorkflowAuthorizeFn | null): void {
		this.authorizeFn = fn;
	}

	/**
	 * Returns `true` when no authorize hook is installed (default-allow),
	 * otherwise delegates to the hook. Called by `SubworkflowNode` before
	 * materializing the child workflow.
	 */
	async authorize(parentName: string, childName: string, ctx: Context): Promise<boolean> {
		if (!this.authorizeFn) return true;
		return await this.authorizeFn(parentName, childName, ctx);
	}

	/**
	 * Register a process-global middleware chain. Every workflow run in
	 * this process will prepend these middleware to its own chain BEFORE
	 * any workflow- or trigger-level middleware execute. Use for ops
	 * concerns that should apply uniformly across the fleet: request-id
	 * correlation, audit logging, OpenTelemetry spans, etc.
	 *
	 * **Lifecycle**: write-once-per-process is the typical pattern (call
	 * once at boot, before `trigger.listen()`), but repeated calls are
	 * allowed and the last call wins. Pass `[]` to clear the global
	 * chain. The list is frozen on store so the snapshot returned by
	 * `getGlobalMiddleware()` is safe to expose without copying.
	 *
	 * Names that don't resolve to a registered middleware workflow are
	 * accepted at registration time but will throw at request time when
	 * `runMiddlewareChain` tries to look them up — mirrors trigger- and
	 * workflow-level middleware semantics. The trigger logs the
	 * resolved global chain at boot so operators can verify the names
	 * were spelled correctly without a request.
	 *
	 * @example
	 * ```ts
	 * // Boot-time setup before trigger.listen()
	 * WorkflowRegistry.getInstance().setGlobalMiddleware([
	 *   "request-id",
	 *   "audit-log",
	 * ]);
	 * ```
	 */
	setGlobalMiddleware(names: readonly string[]): void {
		const filtered = names.filter((n): n is string => typeof n === "string" && n.length > 0).slice();
		this.globalMiddleware = Object.freeze(filtered);
	}

	/**
	 * Snapshot of the process-global middleware chain. Returns the
	 * frozen list set by `setGlobalMiddleware`, or an empty list when
	 * unset. Triggers consume this in `runMiddlewareChain` to prepend
	 * to the per-request chain. Always returns the same reference until
	 * the next setter call.
	 */
	getGlobalMiddleware(): readonly string[] {
		return this.globalMiddleware;
	}

	/**
	 * Register a single workflow. Throws on collision when a workflow
	 * with the same `name` is already registered from a different
	 * `source`. Re-registration of the same `(name, source)` is a
	 * no-op (HMR-friendly).
	 */
	register(entry: RegisteredWorkflow): void {
		if (!entry.name || entry.name.length === 0) {
			throw new Error("[blok] WorkflowRegistry.register: workflow `name` is required.");
		}
		const existing = this.workflows.get(entry.name);
		if (existing && existing.source !== entry.source) {
			throw new Error(
				`[blok] WorkflowRegistry: workflow name collision — "${entry.name}" is already registered from "${existing.source}"; cannot also register from "${entry.source}". Workflow names must be unique across the process.`,
			);
		}
		this.workflows.set(entry.name, entry);
	}

	/** Convenience — register many at once. Stops on first collision. */
	registerAll(entries: readonly RegisteredWorkflow[]): void {
		for (const entry of entries) {
			this.register(entry);
		}
	}

	/** Fetch the registered workflow by name, or undefined on miss. */
	get(name: string): RegisteredWorkflow | undefined {
		return this.workflows.get(name);
	}

	/**
	 * v0.5 — fetch a registered MIDDLEWARE workflow by name (must have
	 * been registered with `isMiddleware: true`). Returns undefined when
	 * the name is unknown OR the entry isn't a middleware. Used by
	 * `HttpTrigger` to dispatch the trigger-level `middleware: [...]` chain.
	 */
	getMiddleware(name: string): RegisteredWorkflow | undefined {
		const entry = this.workflows.get(name);
		if (!entry || !entry.isMiddleware) return undefined;
		return entry;
	}

	/** Cheap existence check (avoids the `?: undefined` dance). */
	has(name: string): boolean {
		return this.workflows.has(name);
	}

	/** Snapshot of all registered workflows — used for error messages. */
	list(): RegisteredWorkflow[] {
		return Array.from(this.workflows.values());
	}

	/**
	 * Drop every registered workflow. Triggers call this before
	 * re-scanning on HMR so stale entries don't survive a file rename.
	 * Does NOT reset the authorize hook OR the global middleware chain
	 * — both are operator-installed and should persist across HMR.
	 * Use `setAuthorizeFn(null)` / `setGlobalMiddleware([])` explicitly
	 * to clear.
	 */
	clear(): void {
		this.workflows.clear();
	}
}
