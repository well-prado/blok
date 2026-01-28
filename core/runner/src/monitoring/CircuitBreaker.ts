/**
 * Circuit Breaker Pattern for Blok Triggers
 *
 * Prevents cascading failures by detecting repeated errors
 * and temporarily disabling failing operations.
 *
 * States:
 * - CLOSED: Normal operation, requests flow through
 * - OPEN: Failures exceeded threshold, requests are rejected
 * - HALF_OPEN: Testing recovery, limited requests allowed
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
	/** Number of failures before opening the circuit */
	failureThreshold: number;
	/** Time in ms before attempting recovery (OPEN -> HALF_OPEN) */
	resetTimeoutMs: number;
	/** Number of successful requests in HALF_OPEN to close the circuit */
	halfOpenMaxAttempts: number;
	/** Optional: time window for failure counting (rolling window) */
	failureWindowMs?: number;
}

export interface CircuitBreakerStats {
	state: CircuitState;
	failures: number;
	successes: number;
	consecutiveFailures: number;
	lastFailure: number | null;
	lastSuccess: number | null;
	lastStateChange: number;
	totalRequests: number;
	totalRejected: number;
}

export type CircuitBreakerEventType = "state_change" | "request_rejected" | "failure" | "success";

export interface CircuitBreakerEvent {
	type: CircuitBreakerEventType;
	state: CircuitState;
	previousState?: CircuitState;
	timestamp: number;
	error?: Error;
}

export type CircuitBreakerListener = (event: CircuitBreakerEvent) => void;

export class CircuitBreaker {
	private state: CircuitState = "CLOSED";
	private failures: number = 0;
	private successes: number = 0;
	private consecutiveFailures: number = 0;
	private halfOpenAttempts: number = 0;
	private lastFailure: number | null = null;
	private lastSuccess: number | null = null;
	private lastStateChange: number = Date.now();
	private totalRequests: number = 0;
	private totalRejected: number = 0;
	private failureTimestamps: number[] = [];
	private config: CircuitBreakerConfig;
	private listeners: CircuitBreakerListener[] = [];
	private resetTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(config: CircuitBreakerConfig) {
		this.config = config;
	}

	/**
	 * Execute a function through the circuit breaker.
	 * Throws CircuitOpenError if the circuit is open.
	 */
	async execute<T>(fn: () => Promise<T>): Promise<T> {
		if (!this.canExecute()) {
			this.totalRejected++;
			this.emit({
				type: "request_rejected",
				state: this.state,
				timestamp: Date.now(),
			});
			throw new CircuitOpenError(
				`Circuit breaker is ${this.state}. Retry after ${this.getRetryAfterMs()}ms`,
				this.getRetryAfterMs(),
			);
		}

		this.totalRequests++;

		try {
			const result = await fn();
			this.onSuccess();
			return result;
		} catch (error) {
			this.onFailure(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	/**
	 * Check if the circuit allows execution without actually executing.
	 */
	canExecute(): boolean {
		switch (this.state) {
			case "CLOSED":
				return true;
			case "OPEN":
				if (Date.now() - this.lastStateChange >= this.config.resetTimeoutMs) {
					this.transitionTo("HALF_OPEN");
					return true;
				}
				return false;
			case "HALF_OPEN":
				return this.halfOpenAttempts < this.config.halfOpenMaxAttempts;
		}
	}

	/**
	 * Get current circuit breaker statistics.
	 */
	getStats(): CircuitBreakerStats {
		return {
			state: this.state,
			failures: this.failures,
			successes: this.successes,
			consecutiveFailures: this.consecutiveFailures,
			lastFailure: this.lastFailure,
			lastSuccess: this.lastSuccess,
			lastStateChange: this.lastStateChange,
			totalRequests: this.totalRequests,
			totalRejected: this.totalRejected,
		};
	}

	/**
	 * Get the current circuit state.
	 */
	getState(): CircuitState {
		// Check if OPEN should transition to HALF_OPEN
		if (this.state === "OPEN" && Date.now() - this.lastStateChange >= this.config.resetTimeoutMs) {
			this.transitionTo("HALF_OPEN");
		}
		return this.state;
	}

	/**
	 * Get estimated time before the circuit will attempt recovery.
	 */
	getRetryAfterMs(): number {
		if (this.state !== "OPEN") return 0;
		const elapsed = Date.now() - this.lastStateChange;
		return Math.max(0, this.config.resetTimeoutMs - elapsed);
	}

	/**
	 * Manually reset the circuit to CLOSED state.
	 */
	reset(): void {
		this.transitionTo("CLOSED");
		this.failures = 0;
		this.successes = 0;
		this.consecutiveFailures = 0;
		this.halfOpenAttempts = 0;
		this.failureTimestamps = [];
		this.clearResetTimer();
	}

	/**
	 * Register an event listener.
	 */
	on(listener: CircuitBreakerListener): void {
		this.listeners.push(listener);
	}

	/**
	 * Remove an event listener.
	 */
	off(listener: CircuitBreakerListener): void {
		this.listeners = this.listeners.filter((l) => l !== listener);
	}

	/**
	 * Clean up resources. Call when shutting down.
	 */
	destroy(): void {
		this.clearResetTimer();
		this.listeners = [];
	}

	private onSuccess(): void {
		this.successes++;
		this.consecutiveFailures = 0;
		this.lastSuccess = Date.now();

		this.emit({
			type: "success",
			state: this.state,
			timestamp: Date.now(),
		});

		if (this.state === "HALF_OPEN") {
			this.halfOpenAttempts++;
			if (this.halfOpenAttempts >= this.config.halfOpenMaxAttempts) {
				this.transitionTo("CLOSED");
				this.failures = 0;
				this.halfOpenAttempts = 0;
				this.failureTimestamps = [];
			}
		}
	}

	private onFailure(error: Error): void {
		this.failures++;
		this.consecutiveFailures++;
		this.lastFailure = Date.now();

		if (this.config.failureWindowMs) {
			this.failureTimestamps.push(Date.now());
			this.pruneOldFailures();
		}

		this.emit({
			type: "failure",
			state: this.state,
			timestamp: Date.now(),
			error,
		});

		if (this.state === "HALF_OPEN") {
			this.transitionTo("OPEN");
			this.halfOpenAttempts = 0;
			this.scheduleResetTimer();
			return;
		}

		const failureCount = this.config.failureWindowMs
			? this.failureTimestamps.length
			: this.consecutiveFailures;

		if (this.state === "CLOSED" && failureCount >= this.config.failureThreshold) {
			this.transitionTo("OPEN");
			this.scheduleResetTimer();
		}
	}

	private transitionTo(newState: CircuitState): void {
		const previousState = this.state;
		if (previousState === newState) return;

		this.state = newState;
		this.lastStateChange = Date.now();

		this.emit({
			type: "state_change",
			state: newState,
			previousState,
			timestamp: Date.now(),
		});
	}

	private pruneOldFailures(): void {
		if (!this.config.failureWindowMs) return;
		const cutoff = Date.now() - this.config.failureWindowMs;
		this.failureTimestamps = this.failureTimestamps.filter((t) => t > cutoff);
	}

	private scheduleResetTimer(): void {
		this.clearResetTimer();
		this.resetTimer = setTimeout(() => {
			if (this.state === "OPEN") {
				this.transitionTo("HALF_OPEN");
			}
		}, this.config.resetTimeoutMs);

		if (this.resetTimer.unref) {
			this.resetTimer.unref();
		}
	}

	private clearResetTimer(): void {
		if (this.resetTimer) {
			clearTimeout(this.resetTimer);
			this.resetTimer = null;
		}
	}

	private emit(event: CircuitBreakerEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// Listeners should not throw
			}
		}
	}
}

export class CircuitOpenError extends Error {
	public retryAfterMs: number;

	constructor(message: string, retryAfterMs: number) {
		super(message);
		this.name = "CircuitOpenError";
		this.retryAfterMs = retryAfterMs;
	}
}
