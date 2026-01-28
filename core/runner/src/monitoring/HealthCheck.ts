/**
 * Health Check Infrastructure for Blok Triggers
 *
 * Provides standardized health check capabilities across all trigger types.
 * Supports Kubernetes readiness/liveness probes and custom dependency checks.
 */

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthCheckResult {
	status: HealthStatus;
	timestamp: number;
	uptime: number;
	checks: Record<string, DependencyHealth>;
}

export interface DependencyHealth {
	status: HealthStatus;
	latency_ms?: number;
	message?: string;
	lastChecked: number;
}

export type DependencyCheckFn = () => Promise<DependencyHealth>;

export class HealthCheck {
	private startTime: number;
	private dependencies: Map<string, DependencyCheckFn> = new Map();
	private cachedResults: Map<string, DependencyHealth> = new Map();
	private cacheMaxAge: number;

	constructor(cacheMaxAgeMs = 5000) {
		this.startTime = Date.now();
		this.cacheMaxAge = cacheMaxAgeMs;
	}

	/**
	 * Register a named dependency health check.
	 */
	registerDependency(name: string, checkFn: DependencyCheckFn): void {
		this.dependencies.set(name, checkFn);
	}

	/**
	 * Remove a registered dependency check.
	 */
	removeDependency(name: string): void {
		this.dependencies.delete(name);
		this.cachedResults.delete(name);
	}

	/**
	 * Run all dependency checks and return aggregated health.
	 */
	async check(): Promise<HealthCheckResult> {
		const checks: Record<string, DependencyHealth> = {};

		const entries = Array.from(this.dependencies.entries());
		const results = await Promise.allSettled(
			entries.map(async ([name, checkFn]) => {
				const cached = this.cachedResults.get(name);
				if (cached && Date.now() - cached.lastChecked < this.cacheMaxAge) {
					return { name, result: cached };
				}

				const start = performance.now();
				try {
					const result = await checkFn();
					result.latency_ms = performance.now() - start;
					result.lastChecked = Date.now();
					this.cachedResults.set(name, result);
					return { name, result };
				} catch (err) {
					const result: DependencyHealth = {
						status: "unhealthy",
						latency_ms: performance.now() - start,
						message: err instanceof Error ? err.message : String(err),
						lastChecked: Date.now(),
					};
					this.cachedResults.set(name, result);
					return { name, result };
				}
			}),
		);

		for (const settled of results) {
			if (settled.status === "fulfilled") {
				checks[settled.value.name] = settled.value.result;
			}
		}

		const status = this.aggregateStatus(checks);

		return {
			status,
			timestamp: Date.now(),
			uptime: Date.now() - this.startTime,
			checks,
		};
	}

	/**
	 * Quick liveness check - is the process alive and responsive?
	 */
	liveness(): { status: "ok"; uptime: number } {
		return {
			status: "ok",
			uptime: Date.now() - this.startTime,
		};
	}

	/**
	 * Readiness check - are all dependencies healthy?
	 */
	async readiness(): Promise<{ ready: boolean; status: HealthStatus }> {
		const result = await this.check();
		return {
			ready: result.status !== "unhealthy",
			status: result.status,
		};
	}

	private aggregateStatus(checks: Record<string, DependencyHealth>): HealthStatus {
		const statuses = Object.values(checks);
		if (statuses.length === 0) return "healthy";
		if (statuses.some((c) => c.status === "unhealthy")) return "unhealthy";
		if (statuses.some((c) => c.status === "degraded")) return "degraded";
		return "healthy";
	}
}
