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
 * **Why a separate class** (vs reusing the HTTP trigger's RouteEntry[]):
 * - Decoupled from HTTP — worker/cron triggers feed the same registry.
 * - Lookup by `name:` is what authors write; route table is keyed on
 *   `(method, path)` which sub-workflow callers don't know.
 * - Test isolation — `resetInstance()` is cheap.
 */

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
}

export class WorkflowRegistry {
	private static instance: WorkflowRegistry | null = null;
	private workflows = new Map<string, RegisteredWorkflow>();

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
	 */
	clear(): void {
		this.workflows.clear();
	}
}
