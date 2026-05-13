/**
 * RoutingDiagnostics — process-wide bag for non-fatal HTTP route-build
 * errors that Studio surfaces in the UI so operators see the problem
 * without tailing the trigger logs.
 *
 * Today this collects route-table collisions detected at boot by the
 * HTTP trigger's `buildRouteTable` (tolerant mode). The trigger records
 * one entry per dropped workflow; Studio polls
 * `GET /__blok/routing` to render a banner on the Workflows page.
 *
 * Lifecycle: a singleton populated once at boot, cleared on HMR
 * (`clear()` is called from the same hot-path as the workflow registry
 * clear). Survives the lifetime of the trigger process otherwise.
 *
 * The `core/runner` package owns this rather than the trigger package
 * because `TraceRouter` (in this package) is where the `/__blok/*`
 * endpoint surface lives, and the trigger package depends on the
 * runner already.
 */

/**
 * Structured route-build problem. Mirrors the trigger's `RouteCollision`
 * shape but is duplicated here so the runner package doesn't need to
 * `import` from the trigger package (the dependency arrow points the
 * other way).
 */
export interface RoutingDiagnostic {
	readonly kind: "duplicate" | "any-shadows-specific" | "missing-path" | "scan-error";
	readonly method?: string;
	readonly path?: string;
	/** The workflow source that "won" / stayed in the table. */
	readonly winnerSource?: string;
	/** The workflow source that was dropped (the offender). */
	readonly droppedSource?: string;
	/** Single-line summary suitable for a Studio banner. */
	readonly message: string;
	/** Wall-clock when the diagnostic was recorded. */
	readonly recordedAt: number;
}

export class RoutingDiagnostics {
	private static instance: RoutingDiagnostics | null = null;
	private entries: RoutingDiagnostic[] = [];

	static getInstance(): RoutingDiagnostics {
		if (!RoutingDiagnostics.instance) {
			RoutingDiagnostics.instance = new RoutingDiagnostics();
		}
		return RoutingDiagnostics.instance;
	}

	/** Test-only — drop the singleton between suites. */
	static resetInstance(): void {
		RoutingDiagnostics.instance = null;
	}

	/** Append one diagnostic. Insertion-order is preserved by `list()`. */
	record(entry: Omit<RoutingDiagnostic, "recordedAt"> & { recordedAt?: number }): void {
		this.entries.push({ ...entry, recordedAt: entry.recordedAt ?? Date.now() });
	}

	/** Snapshot of every recorded diagnostic (insertion order). */
	list(): RoutingDiagnostic[] {
		return [...this.entries];
	}

	/** Total count. Use for the Studio banner badge. */
	count(): number {
		return this.entries.length;
	}

	/** Drop every diagnostic — called on HMR / re-scan. */
	clear(): void {
		this.entries = [];
	}
}
