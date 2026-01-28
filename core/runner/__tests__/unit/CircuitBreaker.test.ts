import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "../../src/monitoring/CircuitBreaker";
import type { CircuitBreakerEvent } from "../../src/monitoring/CircuitBreaker";

describe("CircuitBreaker", () => {
	let breaker: CircuitBreaker;

	afterEach(() => {
		breaker?.destroy();
	});

	describe("CLOSED state", () => {
		beforeEach(() => {
			breaker = new CircuitBreaker({
				failureThreshold: 3,
				resetTimeoutMs: 1000,
				halfOpenMaxAttempts: 2,
			});
		});

		it("should start in CLOSED state", () => {
			expect(breaker.getState()).toBe("CLOSED");
		});

		it("should allow execution in CLOSED state", async () => {
			const result = await breaker.execute(async () => "success");
			expect(result).toBe("success");
		});

		it("should track successful executions", async () => {
			await breaker.execute(async () => "ok");
			const stats = breaker.getStats();
			expect(stats.successes).toBe(1);
			expect(stats.totalRequests).toBe(1);
			expect(stats.state).toBe("CLOSED");
		});

		it("should pass through errors without opening on few failures", async () => {
			await expect(
				breaker.execute(async () => {
					throw new Error("fail");
				}),
			).rejects.toThrow("fail");

			expect(breaker.getState()).toBe("CLOSED");
			expect(breaker.getStats().failures).toBe(1);
		});

		it("should open after reaching failure threshold", async () => {
			for (let i = 0; i < 3; i++) {
				await breaker
					.execute(async () => {
						throw new Error("fail");
					})
					.catch(() => {});
			}

			expect(breaker.getState()).toBe("OPEN");
		});
	});

	describe("OPEN state", () => {
		beforeEach(async () => {
			breaker = new CircuitBreaker({
				failureThreshold: 2,
				resetTimeoutMs: 200,
				halfOpenMaxAttempts: 1,
			});

			// Trip the breaker
			for (let i = 0; i < 2; i++) {
				await breaker
					.execute(async () => {
						throw new Error("fail");
					})
					.catch(() => {});
			}
		});

		it("should reject requests in OPEN state", async () => {
			await expect(breaker.execute(async () => "ok")).rejects.toThrow(CircuitOpenError);
		});

		it("should report rejected requests in stats", async () => {
			await breaker.execute(async () => "ok").catch(() => {});
			const stats = breaker.getStats();
			expect(stats.totalRejected).toBe(1);
		});

		it("should include retryAfterMs in CircuitOpenError", async () => {
			try {
				await breaker.execute(async () => "ok");
			} catch (err) {
				expect(err).toBeInstanceOf(CircuitOpenError);
				expect((err as CircuitOpenError).retryAfterMs).toBeGreaterThan(0);
			}
		});

		it("should transition to HALF_OPEN after reset timeout", async () => {
			await new Promise((r) => setTimeout(r, 250));
			expect(breaker.getState()).toBe("HALF_OPEN");
		});
	});

	describe("HALF_OPEN state", () => {
		beforeEach(async () => {
			breaker = new CircuitBreaker({
				failureThreshold: 2,
				resetTimeoutMs: 50,
				halfOpenMaxAttempts: 2,
			});

			for (let i = 0; i < 2; i++) {
				await breaker
					.execute(async () => {
						throw new Error("fail");
					})
					.catch(() => {});
			}

			await new Promise((r) => setTimeout(r, 100));
		});

		it("should allow limited requests in HALF_OPEN state", async () => {
			expect(breaker.getState()).toBe("HALF_OPEN");
			const result = await breaker.execute(async () => "testing");
			expect(result).toBe("testing");
		});

		it("should close circuit after enough successes in HALF_OPEN", async () => {
			await breaker.execute(async () => "ok");
			await breaker.execute(async () => "ok");
			expect(breaker.getState()).toBe("CLOSED");
		});

		it("should re-open on failure in HALF_OPEN", async () => {
			await breaker
				.execute(async () => {
					throw new Error("fail again");
				})
				.catch(() => {});

			expect(breaker.getState()).toBe("OPEN");
		});
	});

	describe("failure window", () => {
		it("should use rolling window for failure counting", async () => {
			breaker = new CircuitBreaker({
				failureThreshold: 3,
				resetTimeoutMs: 1000,
				halfOpenMaxAttempts: 1,
				failureWindowMs: 100,
			});

			// Fail once
			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});

			// Wait for window to expire
			await new Promise((r) => setTimeout(r, 150));

			// Fail twice more - should NOT open since first failure expired
			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});
			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});

			expect(breaker.getState()).toBe("CLOSED");
		});
	});

	describe("manual reset", () => {
		it("should reset circuit to CLOSED state", async () => {
			breaker = new CircuitBreaker({
				failureThreshold: 1,
				resetTimeoutMs: 10000,
				halfOpenMaxAttempts: 1,
			});

			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});

			expect(breaker.getState()).toBe("OPEN");

			breaker.reset();
			expect(breaker.getState()).toBe("CLOSED");

			const result = await breaker.execute(async () => "recovered");
			expect(result).toBe("recovered");
		});
	});

	describe("event listeners", () => {
		it("should emit state_change events", async () => {
			breaker = new CircuitBreaker({
				failureThreshold: 1,
				resetTimeoutMs: 50,
				halfOpenMaxAttempts: 1,
			});

			const events: CircuitBreakerEvent[] = [];
			breaker.on((event) => events.push(event));

			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});

			const stateChanges = events.filter((e) => e.type === "state_change");
			expect(stateChanges).toHaveLength(1);
			expect(stateChanges[0].state).toBe("OPEN");
			expect(stateChanges[0].previousState).toBe("CLOSED");
		});

		it("should emit failure events", async () => {
			breaker = new CircuitBreaker({
				failureThreshold: 5,
				resetTimeoutMs: 1000,
				halfOpenMaxAttempts: 1,
			});

			const events: CircuitBreakerEvent[] = [];
			breaker.on((event) => events.push(event));

			await breaker
				.execute(async () => {
					throw new Error("oops");
				})
				.catch(() => {});

			const failures = events.filter((e) => e.type === "failure");
			expect(failures).toHaveLength(1);
			expect(failures[0].error?.message).toBe("oops");
		});

		it("should emit success events", async () => {
			breaker = new CircuitBreaker({
				failureThreshold: 5,
				resetTimeoutMs: 1000,
				halfOpenMaxAttempts: 1,
			});

			const events: CircuitBreakerEvent[] = [];
			breaker.on((event) => events.push(event));

			await breaker.execute(async () => "ok");

			const successes = events.filter((e) => e.type === "success");
			expect(successes).toHaveLength(1);
		});

		it("should emit request_rejected events", async () => {
			breaker = new CircuitBreaker({
				failureThreshold: 1,
				resetTimeoutMs: 10000,
				halfOpenMaxAttempts: 1,
			});

			const events: CircuitBreakerEvent[] = [];
			breaker.on((event) => events.push(event));

			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});
			await breaker.execute(async () => "rejected").catch(() => {});

			const rejected = events.filter((e) => e.type === "request_rejected");
			expect(rejected).toHaveLength(1);
		});

		it("should allow removing listeners", async () => {
			breaker = new CircuitBreaker({
				failureThreshold: 5,
				resetTimeoutMs: 1000,
				halfOpenMaxAttempts: 1,
			});

			let callCount = 0;
			const listener = () => {
				callCount++;
			};

			breaker.on(listener);
			await breaker.execute(async () => "ok");
			expect(callCount).toBe(1);

			breaker.off(listener);
			await breaker.execute(async () => "ok");
			expect(callCount).toBe(1);
		});
	});

	describe("canExecute", () => {
		it("should return true in CLOSED state", () => {
			breaker = new CircuitBreaker({
				failureThreshold: 5,
				resetTimeoutMs: 1000,
				halfOpenMaxAttempts: 1,
			});
			expect(breaker.canExecute()).toBe(true);
		});

		it("should return false in OPEN state before timeout", async () => {
			breaker = new CircuitBreaker({
				failureThreshold: 1,
				resetTimeoutMs: 10000,
				halfOpenMaxAttempts: 1,
			});

			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});

			expect(breaker.canExecute()).toBe(false);
		});
	});

	describe("getRetryAfterMs", () => {
		it("should return 0 in CLOSED state", () => {
			breaker = new CircuitBreaker({
				failureThreshold: 5,
				resetTimeoutMs: 1000,
				halfOpenMaxAttempts: 1,
			});
			expect(breaker.getRetryAfterMs()).toBe(0);
		});

		it("should return remaining time in OPEN state", async () => {
			breaker = new CircuitBreaker({
				failureThreshold: 1,
				resetTimeoutMs: 1000,
				halfOpenMaxAttempts: 1,
			});

			await breaker
				.execute(async () => {
					throw new Error("fail");
				})
				.catch(() => {});

			const retryAfter = breaker.getRetryAfterMs();
			expect(retryAfter).toBeGreaterThan(0);
			expect(retryAfter).toBeLessThanOrEqual(1000);
		});
	});
});
