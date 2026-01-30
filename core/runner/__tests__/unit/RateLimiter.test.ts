import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../../src/monitoring/RateLimiter";

describe("RateLimiter", () => {
	let limiter: RateLimiter;

	afterEach(() => {
		limiter?.destroy();
	});

	describe("basic consumption", () => {
		beforeEach(() => {
			limiter = new RateLimiter({ maxTokens: 10, refillRate: 1 });
		});

		it("should allow requests under the limit", () => {
			const result = limiter.consume("client-1");
			expect(result.allowed).toBe(true);
			expect(result.remaining).toBe(9);
			expect(result.limit).toBe(10);
			expect(result.retryAfterMs).toBe(0);
		});

		it("should track remaining tokens correctly", () => {
			for (let i = 0; i < 5; i++) {
				limiter.consume("client-1");
			}
			const result = limiter.consume("client-1");
			expect(result.allowed).toBe(true);
			expect(result.remaining).toBe(4);
		});

		it("should reject requests when tokens are exhausted", () => {
			for (let i = 0; i < 10; i++) {
				limiter.consume("client-1");
			}
			const result = limiter.consume("client-1");
			expect(result.allowed).toBe(false);
			expect(result.remaining).toBe(0);
			expect(result.retryAfterMs).toBeGreaterThan(0);
		});

		it("should track separate buckets per key", () => {
			for (let i = 0; i < 10; i++) {
				limiter.consume("client-1");
			}
			const result1 = limiter.consume("client-1");
			const result2 = limiter.consume("client-2");

			expect(result1.allowed).toBe(false);
			expect(result2.allowed).toBe(true);
			expect(result2.remaining).toBe(9);
		});

		it("should consume multiple tokens at once", () => {
			const result = limiter.consume("client-1", 5);
			expect(result.allowed).toBe(true);
			expect(result.remaining).toBe(5);
		});

		it("should reject when not enough tokens for multi-consume", () => {
			limiter.consume("client-1", 8);
			const result = limiter.consume("client-1", 5);
			expect(result.allowed).toBe(false);
		});
	});

	describe("token refill", () => {
		it("should refill tokens over time", async () => {
			limiter = new RateLimiter({ maxTokens: 5, refillRate: 100 }); // 100 tokens/sec
			for (let i = 0; i < 5; i++) {
				limiter.consume("client-1");
			}

			let result = limiter.consume("client-1");
			expect(result.allowed).toBe(false);

			await new Promise((r) => setTimeout(r, 60));

			result = limiter.consume("client-1");
			expect(result.allowed).toBe(true);
		});

		it("should not exceed maxTokens after refill", async () => {
			limiter = new RateLimiter({ maxTokens: 5, refillRate: 1000 });
			await new Promise((r) => setTimeout(r, 50));

			const result = limiter.consume("client-1");
			expect(result.remaining).toBeLessThanOrEqual(5);
		});
	});

	describe("peek", () => {
		beforeEach(() => {
			limiter = new RateLimiter({ maxTokens: 10, refillRate: 1 });
		});

		it("should check limit without consuming tokens", () => {
			const peek1 = limiter.peek("client-1");
			expect(peek1.allowed).toBe(true);
			expect(peek1.remaining).toBe(10);

			const peek2 = limiter.peek("client-1");
			expect(peek2.remaining).toBe(10);
		});

		it("should return full tokens for unknown keys", () => {
			const result = limiter.peek("unknown");
			expect(result.allowed).toBe(true);
			expect(result.remaining).toBe(10);
		});
	});

	describe("reset", () => {
		beforeEach(() => {
			limiter = new RateLimiter({ maxTokens: 5, refillRate: 1 });
		});

		it("should reset a specific key", () => {
			for (let i = 0; i < 5; i++) {
				limiter.consume("client-1");
			}
			expect(limiter.consume("client-1").allowed).toBe(false);

			limiter.reset("client-1");
			expect(limiter.consume("client-1").allowed).toBe(true);
			expect(limiter.consume("client-1").remaining).toBe(3);
		});

		it("should reset all keys", () => {
			for (let i = 0; i < 5; i++) {
				limiter.consume("client-1");
				limiter.consume("client-2");
			}
			limiter.resetAll();

			expect(limiter.consume("client-1").allowed).toBe(true);
			expect(limiter.consume("client-2").allowed).toBe(true);
		});
	});

	describe("stats", () => {
		it("should report active bucket count", () => {
			limiter = new RateLimiter({ maxTokens: 10, refillRate: 1 });
			limiter.consume("a");
			limiter.consume("b");
			limiter.consume("c");

			const stats = limiter.getStats();
			expect(stats.activeBuckets).toBe(3);
			expect(stats.config.maxTokens).toBe(10);
			expect(stats.config.refillRate).toBe(1);
		});
	});

	describe("cleanup", () => {
		it("should clean up idle buckets", async () => {
			limiter = new RateLimiter({ maxTokens: 10, refillRate: 1 }, 100); // 100ms idle
			limiter.consume("ephemeral");

			expect(limiter.getStats().activeBuckets).toBe(1);

			// Wait long enough for cleanup interval to fire (interval = bucketMaxIdleMs = 100ms)
			await new Promise((r) => setTimeout(r, 350));

			expect(limiter.getStats().activeBuckets).toBe(0);
		});
	});
});
