/**
 * RuntimeAutoScaler - Automatic Container Pool Scaling for Blok Runtimes
 *
 * Monitors runtime execution load and automatically adjusts Docker container
 * pool sizes based on configurable scaling policies. Tracks metrics like RPS,
 * p95 latency, and CPU utilization to make informed scaling decisions.
 *
 * Follows patterns from DockerRuntimeAdapter (pool management, health checks)
 * and TriggerMetricsCollector (metrics tracking, percentile calculations).
 */

import type { RuntimeKind } from "../adapters/RuntimeAdapter";
import type { RuntimeMetricsDashboard } from "./RuntimeMetricsDashboard";

export interface ScalingPolicy {
	runtime: RuntimeKind;
	minInstances: number;
	maxInstances: number;
	targetCpuUtilization: number;
	targetLatencyMs: number;
	targetRps: number;
	scaleUpCooldownMs: number;
	scaleDownCooldownMs: number;
	scaleUpStep: number;
	scaleDownStep: number;
}

export interface ScalingMetrics {
	currentRps: number;
	currentLatencyP95: number;
	currentCpuUtilization: number;
	instanceUtilization: number;
}

export interface ScalingDecision {
	runtime: RuntimeKind;
	action: "scale_up" | "scale_down" | "no_change";
	currentInstances: number;
	desiredInstances: number;
	reason: string;
	timestamp: number;
	metrics: ScalingMetrics;
}

export interface ScalingHistory {
	decisions: ScalingDecision[];
	scaleUpCount: number;
	scaleDownCount: number;
	lastScaleUp: number;
	lastScaleDown: number;
}

export interface AutoScalerConfig {
	evaluationIntervalMs: number;
	enabled: boolean;
	dryRun: boolean;
}

export type ScalingListener = (decision: ScalingDecision) => void;

const DEFAULT_POLICY: Omit<ScalingPolicy, "runtime"> = {
	minInstances: 1,
	maxInstances: 10,
	targetCpuUtilization: 70,
	targetLatencyMs: 200,
	targetRps: 100,
	scaleUpCooldownMs: 60_000,
	scaleDownCooldownMs: 300_000,
	scaleUpStep: 1,
	scaleDownStep: 1,
};

const DEFAULT_CONFIG: AutoScalerConfig = {
	evaluationIntervalMs: 30_000,
	enabled: true,
	dryRun: false,
};

const MAX_HISTORY_DECISIONS = 500;

/**
 * RuntimeAutoScaler monitors runtime execution load and automatically
 * adjusts Docker container pool sizes based on scaling policies.
 *
 * It periodically evaluates metrics from the RuntimeMetricsDashboard and
 * produces ScalingDecisions that indicate whether to scale up, scale down,
 * or maintain the current number of instances.
 */
export class RuntimeAutoScaler {
	private policies: Map<RuntimeKind, ScalingPolicy> = new Map();
	private history: Map<RuntimeKind, ScalingHistory> = new Map();
	private listeners: ScalingListener[] = [];
	private interval: NodeJS.Timeout | undefined;
	private dashboard: RuntimeMetricsDashboard;
	private config: AutoScalerConfig;

	constructor(dashboard: RuntimeMetricsDashboard, config?: Partial<AutoScalerConfig>) {
		this.dashboard = dashboard;
		this.config = {
			evaluationIntervalMs: config?.evaluationIntervalMs ?? DEFAULT_CONFIG.evaluationIntervalMs,
			enabled: config?.enabled ?? DEFAULT_CONFIG.enabled,
			dryRun: config?.dryRun ?? DEFAULT_CONFIG.dryRun,
		};
	}

	/**
	 * Set a scaling policy for a runtime.
	 * Merges provided values with defaults.
	 */
	setPolicy(policy: ScalingPolicy): void {
		this.policies.set(policy.runtime, {
			...DEFAULT_POLICY,
			...policy,
		});

		// Initialize history for this runtime if not present
		if (!this.history.has(policy.runtime)) {
			this.history.set(policy.runtime, {
				decisions: [],
				scaleUpCount: 0,
				scaleDownCount: 0,
				lastScaleUp: 0,
				lastScaleDown: 0,
			});
		}
	}

	/**
	 * Get the scaling policy for a runtime.
	 */
	getPolicy(runtime: RuntimeKind): ScalingPolicy | undefined {
		return this.policies.get(runtime);
	}

	/**
	 * Remove the scaling policy for a runtime.
	 */
	removePolicy(runtime: RuntimeKind): void {
		this.policies.delete(runtime);
	}

	/**
	 * Begin periodic evaluation of all runtime scaling policies.
	 */
	start(): void {
		if (!this.config.enabled) {
			return;
		}

		if (this.interval) {
			clearInterval(this.interval);
		}

		this.interval = setInterval(() => {
			this.evaluateAll();
		}, this.config.evaluationIntervalMs);
	}

	/**
	 * Stop periodic evaluation.
	 */
	stop(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
	}

	/**
	 * Evaluate a single runtime against its scaling policy.
	 *
	 * The evaluation logic:
	 * 1. Get current metrics from RuntimeMetricsDashboard
	 * 2. Get the scaling policy for this runtime
	 * 3. Check cooldown periods (don't scale too frequently)
	 * 4. Determine desired instances based on RPS, latency, and CPU thresholds
	 * 5. Clamp desired between minInstances and maxInstances
	 * 6. Create ScalingDecision with descriptive reason
	 * 7. Record in history and notify listeners
	 */
	evaluate(runtime: RuntimeKind): ScalingDecision {
		const policy = this.policies.get(runtime);
		if (!policy) {
			return this.createNoChangeDecision(runtime, 0, "No scaling policy configured for this runtime");
		}

		const metrics = this.collectMetrics(runtime);
		const history = this.getOrCreateHistory(runtime);
		const now = Date.now();

		// Determine current instance count from instance utilization and max
		const currentInstances = Math.max(
			policy.minInstances,
			Math.round((metrics.instanceUtilization / 100) * policy.maxInstances) || policy.minInstances,
		);

		let desiredInstances = currentInstances;
		let action: ScalingDecision["action"] = "no_change";
		let reason = "All metrics within acceptable thresholds";

		// Check if scale up is needed
		const rpsExceeded = metrics.currentRps > policy.targetRps * currentInstances;
		const latencyExceeded = metrics.currentLatencyP95 > policy.targetLatencyMs;
		const cpuExceeded = metrics.currentCpuUtilization > policy.targetCpuUtilization;

		if (rpsExceeded || latencyExceeded) {
			// Check scale-up cooldown
			const timeSinceLastScaleUp = now - history.lastScaleUp;
			if (timeSinceLastScaleUp < policy.scaleUpCooldownMs && history.lastScaleUp > 0) {
				reason = `Scale up needed but in cooldown (${Math.round((policy.scaleUpCooldownMs - timeSinceLastScaleUp) / 1000)}s remaining)`;
			} else {
				desiredInstances = currentInstances + policy.scaleUpStep;
				action = "scale_up";

				const reasons: string[] = [];
				if (rpsExceeded) {
					reasons.push(
						`RPS ${metrics.currentRps.toFixed(1)} exceeds target ${policy.targetRps * currentInstances} (${policy.targetRps}/instance * ${currentInstances})`,
					);
				}
				if (latencyExceeded) {
					reasons.push(
						`p95 latency ${metrics.currentLatencyP95.toFixed(1)}ms exceeds target ${policy.targetLatencyMs}ms`,
					);
				}
				if (cpuExceeded) {
					reasons.push(
						`CPU utilization ${metrics.currentCpuUtilization.toFixed(1)}% exceeds target ${policy.targetCpuUtilization}%`,
					);
				}
				reason = `Scaling up: ${reasons.join("; ")}`;
			}
		} else {
			// Check if scale down is possible
			const canScaleDown = currentInstances > policy.minInstances;
			const rpsAllowsScaleDown = metrics.currentRps < policy.targetRps * (currentInstances - 1);
			const latencyIsGood = metrics.currentLatencyP95 <= policy.targetLatencyMs;

			if (canScaleDown && rpsAllowsScaleDown && latencyIsGood) {
				// Check scale-down cooldown
				const timeSinceLastScaleDown = now - history.lastScaleDown;
				if (timeSinceLastScaleDown < policy.scaleDownCooldownMs && history.lastScaleDown > 0) {
					reason = `Scale down possible but in cooldown (${Math.round((policy.scaleDownCooldownMs - timeSinceLastScaleDown) / 1000)}s remaining)`;
				} else {
					desiredInstances = currentInstances - policy.scaleDownStep;
					action = "scale_down";
					reason = `Scaling down: RPS ${metrics.currentRps.toFixed(1)} is below threshold ${policy.targetRps * (currentInstances - 1)} for ${currentInstances - 1} instances, latency ${metrics.currentLatencyP95.toFixed(1)}ms is within target ${policy.targetLatencyMs}ms`;
				}
			}
		}

		// Clamp desired instances between min and max
		desiredInstances = Math.max(policy.minInstances, Math.min(policy.maxInstances, desiredInstances));

		// If clamping changed the desired count back to current, it's a no_change
		if (desiredInstances === currentInstances) {
			action = "no_change";
			if (desiredInstances >= policy.maxInstances && (rpsExceeded || latencyExceeded)) {
				reason = `At maximum capacity (${policy.maxInstances} instances), cannot scale further`;
			}
		}

		const decision: ScalingDecision = {
			runtime,
			action,
			currentInstances,
			desiredInstances,
			reason,
			timestamp: now,
			metrics,
		};

		// Record in history
		this.recordDecision(runtime, decision);

		// Notify listeners
		this.notifyListeners(decision);

		return decision;
	}

	/**
	 * Evaluate all runtimes that have scaling policies.
	 */
	evaluateAll(): ScalingDecision[] {
		const decisions: ScalingDecision[] = [];

		for (const runtime of this.policies.keys()) {
			const decision = this.evaluate(runtime);
			decisions.push(decision);
		}

		return decisions;
	}

	/**
	 * Get the scaling history for a runtime.
	 */
	getHistory(runtime: RuntimeKind): ScalingHistory | undefined {
		return this.history.get(runtime);
	}

	/**
	 * Get scaling history for all runtimes.
	 */
	getAllHistory(): Map<RuntimeKind, ScalingHistory> {
		return new Map(this.history);
	}

	/**
	 * Subscribe to scaling decisions. Returns an unsubscribe function.
	 */
	onScalingDecision(listener: ScalingListener): () => void {
		this.listeners.push(listener);

		return () => {
			const index = this.listeners.indexOf(listener);
			if (index !== -1) {
				this.listeners.splice(index, 1);
			}
		};
	}

	/**
	 * Suggest a scaling policy based on current runtime metrics.
	 * Uses observed metrics to derive sensible defaults.
	 */
	getRecommendedPolicy(runtime: RuntimeKind): ScalingPolicy {
		const metrics = this.collectMetrics(runtime);

		// Base recommendations on current observed load
		const recommendedTargetRps = metrics.currentRps > 0
			? Math.ceil(metrics.currentRps * 1.5)
			: DEFAULT_POLICY.targetRps;

		const recommendedTargetLatency = metrics.currentLatencyP95 > 0
			? Math.ceil(metrics.currentLatencyP95 * 1.25)
			: DEFAULT_POLICY.targetLatencyMs;

		const recommendedMinInstances = metrics.currentRps > 0
			? Math.max(1, Math.ceil(metrics.currentRps / recommendedTargetRps))
			: DEFAULT_POLICY.minInstances;

		const recommendedMaxInstances = Math.max(
			recommendedMinInstances * 3,
			DEFAULT_POLICY.maxInstances,
		);

		return {
			runtime,
			minInstances: recommendedMinInstances,
			maxInstances: recommendedMaxInstances,
			targetCpuUtilization: DEFAULT_POLICY.targetCpuUtilization,
			targetLatencyMs: recommendedTargetLatency,
			targetRps: recommendedTargetRps,
			scaleUpCooldownMs: DEFAULT_POLICY.scaleUpCooldownMs,
			scaleDownCooldownMs: DEFAULT_POLICY.scaleDownCooldownMs,
			scaleUpStep: DEFAULT_POLICY.scaleUpStep,
			scaleDownStep: DEFAULT_POLICY.scaleDownStep,
		};
	}

	/**
	 * Clear all history, policies, and state.
	 */
	reset(): void {
		this.stop();
		this.policies.clear();
		this.history.clear();
		this.listeners = [];
	}

	/**
	 * Collect current scaling metrics from the RuntimeMetricsDashboard.
	 */
	private collectMetrics(runtime: RuntimeKind): ScalingMetrics {
		const executionMetrics = this.dashboard.getMetrics(runtime);

		if (!executionMetrics) {
			return {
				currentRps: 0,
				currentLatencyP95: 0,
				currentCpuUtilization: 0,
				instanceUtilization: 0,
			};
		}

		const policy = this.policies.get(runtime);
		const maxInstances = policy?.maxInstances ?? DEFAULT_POLICY.maxInstances;
		const minInstances = policy?.minInstances ?? DEFAULT_POLICY.minInstances;

		// Estimate current instance count from total executions and RPS
		// In the absence of a direct instance count, use minInstances as the baseline
		const currentInstances = Math.max(minInstances, 1);

		return {
			currentRps: executionMetrics.throughput.requestsPerSecond,
			currentLatencyP95: executionMetrics.latency.p95,
			currentCpuUtilization: executionMetrics.resourceUsage.avgCpuMs > 0
				? Math.min(100, (executionMetrics.resourceUsage.avgCpuMs / 1000) * 100)
				: 0,
			instanceUtilization: maxInstances > 0
				? (currentInstances / maxInstances) * 100
				: 0,
		};
	}

	/**
	 * Create a no-change decision with the given reason.
	 */
	private createNoChangeDecision(
		runtime: RuntimeKind,
		currentInstances: number,
		reason: string,
	): ScalingDecision {
		return {
			runtime,
			action: "no_change",
			currentInstances,
			desiredInstances: currentInstances,
			reason,
			timestamp: Date.now(),
			metrics: {
				currentRps: 0,
				currentLatencyP95: 0,
				currentCpuUtilization: 0,
				instanceUtilization: 0,
			},
		};
	}

	/**
	 * Get or create history entry for a runtime.
	 */
	private getOrCreateHistory(runtime: RuntimeKind): ScalingHistory {
		let history = this.history.get(runtime);
		if (!history) {
			history = {
				decisions: [],
				scaleUpCount: 0,
				scaleDownCount: 0,
				lastScaleUp: 0,
				lastScaleDown: 0,
			};
			this.history.set(runtime, history);
		}
		return history;
	}

	/**
	 * Record a scaling decision in the history.
	 */
	private recordDecision(runtime: RuntimeKind, decision: ScalingDecision): void {
		const history = this.getOrCreateHistory(runtime);

		history.decisions.push(decision);

		// Prune old decisions to avoid unbounded growth
		if (history.decisions.length > MAX_HISTORY_DECISIONS) {
			history.decisions = history.decisions.slice(-MAX_HISTORY_DECISIONS / 2);
		}

		if (decision.action === "scale_up") {
			history.scaleUpCount++;
			history.lastScaleUp = decision.timestamp;
		} else if (decision.action === "scale_down") {
			history.scaleDownCount++;
			history.lastScaleDown = decision.timestamp;
		}
	}

	/**
	 * Notify all registered listeners of a scaling decision.
	 */
	private notifyListeners(decision: ScalingDecision): void {
		for (const listener of this.listeners) {
			try {
				listener(decision);
			} catch {
				// Listener errors should not break the evaluation loop
			}
		}
	}
}
