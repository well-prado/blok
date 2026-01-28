/**
 * Token Bucket Rate Limiter for Blok Triggers
 *
 * Implements the token bucket algorithm for rate limiting trigger events.
 * Supports per-client, per-workflow, and per-topic rate limiting.
 */

export interface RateLimitConfig {
	/** Maximum number of tokens in the bucket */
	maxTokens: number;
	/** Tokens added per second */
	refillRate: number;
	/** Key strategy for identifying rate limit buckets */
	keyStrategy?: "client" | "workflow" | "topic" | "global";
}

export interface RateLimitResult {
	allowed: boolean;
	remaining: number;
	retryAfterMs: number;
	limit: number;
}

interface Bucket {
	tokens: number;
	lastRefill: number;
}

export class RateLimiter {
	private buckets: Map<string, Bucket> = new Map();
	private config: RateLimitConfig;
	private cleanupInterval: ReturnType<typeof setInterval> | null = null;
	private bucketMaxIdleMs: number;

	constructor(config: RateLimitConfig, bucketMaxIdleMs = 60_000) {
		this.config = config;
		this.bucketMaxIdleMs = bucketMaxIdleMs;
		this.startCleanup();
	}

	/**
	 * Check if a request is allowed under the rate limit.
	 * Consumes a token if allowed.
	 */
	consume(key: string, tokens = 1): RateLimitResult {
		const bucket = this.getOrCreateBucket(key);
		this.refill(bucket);

		if (bucket.tokens >= tokens) {
			bucket.tokens -= tokens;
			return {
				allowed: true,
				remaining: Math.floor(bucket.tokens),
				retryAfterMs: 0,
				limit: this.config.maxTokens,
			};
		}

		const tokensNeeded = tokens - bucket.tokens;
		const retryAfterMs = Math.ceil((tokensNeeded / this.config.refillRate) * 1000);

		return {
			allowed: false,
			remaining: 0,
			retryAfterMs,
			limit: this.config.maxTokens,
		};
	}

	/**
	 * Check rate limit without consuming a token.
	 */
	peek(key: string): RateLimitResult {
		const bucket = this.buckets.get(key);
		if (!bucket) {
			return {
				allowed: true,
				remaining: this.config.maxTokens,
				retryAfterMs: 0,
				limit: this.config.maxTokens,
			};
		}

		const cloned = { ...bucket };
		this.refill(cloned);

		return {
			allowed: cloned.tokens >= 1,
			remaining: Math.floor(cloned.tokens),
			retryAfterMs: cloned.tokens >= 1 ? 0 : Math.ceil((1 / this.config.refillRate) * 1000),
			limit: this.config.maxTokens,
		};
	}

	/**
	 * Reset the rate limiter for a specific key.
	 */
	reset(key: string): void {
		this.buckets.delete(key);
	}

	/**
	 * Reset all rate limit buckets.
	 */
	resetAll(): void {
		this.buckets.clear();
	}

	/**
	 * Get current stats for monitoring.
	 */
	getStats(): { activeBuckets: number; config: RateLimitConfig } {
		return {
			activeBuckets: this.buckets.size,
			config: { ...this.config },
		};
	}

	/**
	 * Stop the cleanup interval. Call when shutting down.
	 */
	destroy(): void {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}
		this.buckets.clear();
	}

	private getOrCreateBucket(key: string): Bucket {
		let bucket = this.buckets.get(key);
		if (!bucket) {
			bucket = {
				tokens: this.config.maxTokens,
				lastRefill: Date.now(),
			};
			this.buckets.set(key, bucket);
		}
		return bucket;
	}

	private refill(bucket: Bucket): void {
		const now = Date.now();
		const elapsed = (now - bucket.lastRefill) / 1000;
		const tokensToAdd = elapsed * this.config.refillRate;

		bucket.tokens = Math.min(this.config.maxTokens, bucket.tokens + tokensToAdd);
		bucket.lastRefill = now;
	}

	private startCleanup(): void {
		this.cleanupInterval = setInterval(() => {
			const now = Date.now();
			for (const [key, bucket] of this.buckets.entries()) {
				if (now - bucket.lastRefill > this.bucketMaxIdleMs) {
					this.buckets.delete(key);
				}
			}
		}, this.bucketMaxIdleMs);

		// Don't prevent process exit
		if (this.cleanupInterval.unref) {
			this.cleanupInterval.unref();
		}
	}
}
