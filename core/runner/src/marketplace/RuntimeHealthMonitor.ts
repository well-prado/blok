/**
 * RuntimeHealthMonitor - Health Monitoring for Blok Runtime Adapters
 *
 * Tracks the health of all registered runtime adapters with periodic
 * health checks, status transitions, uptime tracking, and event-driven
 * notifications following the same patterns as TriggerMetricsCollector.
 */

import type { RuntimeRegistry } from "../RuntimeRegistry";
import type { RuntimeKind } from "../adapters/RuntimeAdapter";

export interface RuntimeHealthStatus {
	runtime: RuntimeKind;
	status: "healthy" | "degraded" | "unhealthy" | "unknown";
	lastCheck: number;
	lastSuccess: number;
	consecutiveFailures: number;
	uptime: number;
	latencyMs: number;
	details: Record<string, unknown>;
}

export interface HealthMonitorConfig {
	checkIntervalMs: number;
	unhealthyThreshold: number;
	degradedThreshold: number;
	timeoutMs: number;
	historySize: number;
}

export interface HealthCheckRecord {
	runtime: RuntimeKind;
	timestamp: number;
	status: "healthy" | "degraded" | "unhealthy" | "unknown";
	latencyMs: number;
	error?: string;
}

export type HealthChangeListener = (runtime: RuntimeKind, oldStatus: string, newStatus: string) => void;

const DEFAULT_CONFIG: HealthMonitorConfig = {
	checkIntervalMs: 30_000,
	unhealthyThreshold: 3,
	degradedThreshold: 1,
	timeoutMs: 5_000,
	historySize: 100,
};

export class RuntimeHealthMonitor {
	private registry: RuntimeRegistry;
	private config: HealthMonitorConfig;
	private healthStatuses: Map<RuntimeKind, RuntimeHealthStatus> = new Map();
	private history: HealthCheckRecord[] = [];
	private listeners: HealthChangeListener[] = [];
	private interval: NodeJS.Timeout | undefined;

	constructor(registry: RuntimeRegistry, config?: Partial<HealthMonitorConfig>) {
		this.registry = registry;
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Begin periodic health checks using setInterval.
	 */
	start(): void {
		if (this.interval) {
			return;
		}
		// Perform an initial check immediately
		this.checkAll();
		this.interval = setInterval(() => {
			this.checkAll();
		}, this.config.checkIntervalMs);
	}

	/**
	 * Stop periodic health checks.
	 */
	stop(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
	}

	/**
	 * Check all registered runtimes and return their health statuses.
	 */
	async checkAll(): Promise<Map<RuntimeKind, RuntimeHealthStatus>> {
		const kinds = this.registry.getRegisteredKinds();
		const results = new Map<RuntimeKind, RuntimeHealthStatus>();

		for (const kind of kinds) {
			const status = await this.checkRuntime(kind);
			results.set(kind, status);
		}

		return results;
	}

	/**
	 * Check a specific runtime by verifying adapter availability and responsiveness.
	 */
	async checkRuntime(runtime: RuntimeKind): Promise<RuntimeHealthStatus> {
		const startTime = Date.now();
		const previousStatus = this.healthStatuses.get(runtime);
		const oldStatusLabel = previousStatus?.status ?? "unknown";

		let newStatus: RuntimeHealthStatus;

		try {
			// Verify the adapter is registered and functional by attempting to retrieve it.
			// Wrap in a timeout to detect hung adapters.
			await this.withTimeout(async () => {
				const adapter = this.registry.get(runtime);
				// Verify the adapter object is present and has the expected kind
				if (adapter.kind !== runtime) {
					throw new Error(`Adapter kind mismatch: expected ${runtime}, got ${adapter.kind}`);
				}
			}, this.config.timeoutMs);

			const latencyMs = Date.now() - startTime;
			const consecutiveFailures = 0;
			const status = "healthy" as const;

			newStatus = {
				runtime,
				status,
				lastCheck: Date.now(),
				lastSuccess: Date.now(),
				consecutiveFailures,
				uptime: 0,
				latencyMs,
				details: {},
			};
		} catch (err) {
			const latencyMs = Date.now() - startTime;
			const consecutiveFailures = (previousStatus?.consecutiveFailures ?? 0) + 1;
			const errorMessage = err instanceof Error ? err.message : String(err);

			let status: "degraded" | "unhealthy";
			if (consecutiveFailures >= this.config.unhealthyThreshold) {
				status = "unhealthy";
			} else if (consecutiveFailures >= this.config.degradedThreshold) {
				status = "degraded";
			} else {
				status = "degraded";
			}

			newStatus = {
				runtime,
				status,
				lastCheck: Date.now(),
				lastSuccess: previousStatus?.lastSuccess ?? 0,
				consecutiveFailures,
				uptime: 0,
				latencyMs,
				details: { error: errorMessage },
			};
		}

		// Record check in history
		const record: HealthCheckRecord = {
			runtime,
			timestamp: newStatus.lastCheck,
			status: newStatus.status,
			latencyMs: newStatus.latencyMs,
			...(newStatus.details.error ? { error: newStatus.details.error as string } : {}),
		};

		this.history.push(record);
		if (this.history.length > this.config.historySize) {
			this.history = this.history.slice(-this.config.historySize);
		}

		// Calculate uptime from history
		newStatus.uptime = this.calculateUptimeFromHistory(runtime);

		// Store updated status
		this.healthStatuses.set(runtime, newStatus);

		// Emit health change events when status transitions
		if (oldStatusLabel !== newStatus.status) {
			this.emitHealthChange(runtime, oldStatusLabel, newStatus.status);
		}

		return newStatus;
	}

	/**
	 * Get current status for a specific runtime.
	 */
	getStatus(runtime: RuntimeKind): RuntimeHealthStatus | undefined {
		return this.healthStatuses.get(runtime);
	}

	/**
	 * Get all current health statuses.
	 */
	getAllStatuses(): RuntimeHealthStatus[] {
		return Array.from(this.healthStatuses.values());
	}

	/**
	 * Get check history, optionally filtered by runtime and limited in count.
	 */
	getHistory(runtime?: RuntimeKind, limit?: number): HealthCheckRecord[] {
		let records = [...this.history];

		if (runtime) {
			records = records.filter((r) => r.runtime === runtime);
		}

		if (limit !== undefined && limit > 0) {
			records = records.slice(-limit);
		}

		return records;
	}

	/**
	 * Subscribe to status change events. Returns an unsubscribe function.
	 */
	onHealthChange(listener: HealthChangeListener): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index !== -1) {
				this.listeners.splice(index, 1);
			}
		};
	}

	/**
	 * Quick check if a runtime is currently healthy.
	 */
	isHealthy(runtime: RuntimeKind): boolean {
		const status = this.healthStatuses.get(runtime);
		return status?.status === "healthy";
	}

	/**
	 * Calculate uptime percentage from history for a given runtime.
	 */
	getUptimePercentage(runtime: RuntimeKind): number {
		return this.calculateUptimeFromHistory(runtime);
	}

	/**
	 * Clear all status data and history.
	 */
	reset(): void {
		this.healthStatuses.clear();
		this.history = [];
	}

	/**
	 * Calculate uptime percentage from recorded history for a specific runtime.
	 * Uptime is the ratio of healthy checks to total checks, expressed as 0-100.
	 */
	private calculateUptimeFromHistory(runtime: RuntimeKind): number {
		const runtimeHistory = this.history.filter((r) => r.runtime === runtime);
		if (runtimeHistory.length === 0) {
			return 100;
		}

		const healthyChecks = runtimeHistory.filter((r) => r.status === "healthy").length;
		return (healthyChecks / runtimeHistory.length) * 100;
	}

	/**
	 * Notify all listeners of a health status change.
	 */
	private emitHealthChange(runtime: RuntimeKind, oldStatus: string, newStatus: string): void {
		for (const listener of this.listeners) {
			try {
				listener(runtime, oldStatus, newStatus);
			} catch {
				// Swallow listener errors to avoid breaking the monitor loop
			}
		}
	}

	/**
	 * Execute an async function with a timeout.
	 */
	private withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`Health check timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			fn()
				.then((result) => {
					clearTimeout(timer);
					resolve(result);
				})
				.catch((err) => {
					clearTimeout(timer);
					reject(err);
				});
		});
	}
}
