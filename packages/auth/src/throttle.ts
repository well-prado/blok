/**
 * Login throttling (#1018) — a fixed-window counter, per IP + email.
 *
 * ponytail: a `Map` in this process, not the `@blokjs/in-memory-kv` node and
 * not Redis.
 *
 * - The KV node buys nothing here: it is the same `Map` behind a step, with no
 *   TTL and no atomic increment, plus a workflow step per attempt.
 * - **CEILING: one process.** Five replicas means five buckets, so the real
 *   limit is `5 × replicas` per minute. That still turns an online password
 *   guess from "unbounded" into "a few per minute per replica", which is what
 *   throttling is for; it is not a distributed rate limiter.
 * - **Upgrade path** when you run more than one replica: implement
 *   {@link ThrottleBackend} over Redis (`INCR` + `EXPIRE`, which IS atomic) and
 *   pass it to {@link setThrottleBackend}. `@blokjs/redis-kv` already carries
 *   the shared `ioredis` client if you want one.
 *
 * The bucket is keyed by IP **and** email so one attacker cannot lock a victim
 * out of their own account by burning the email's budget from elsewhere, and so
 * one shared NAT does not throttle a whole office after five bad attempts.
 */

/** A pluggable counter. Implement it over Redis to make the limit fleet-wide. */
export interface ThrottleBackend {
	/** Count this attempt and return the running total inside the window. */
	hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
	/** Forget the key — called on a SUCCESSFUL login. */
	clear(key: string): Promise<void>;
}

interface Bucket {
	count: number;
	resetAt: number;
}

class MemoryThrottle implements ThrottleBackend {
	private readonly buckets = new Map<string, Bucket>();

	async hit(key: string, windowMs: number): Promise<Bucket> {
		const now = Date.now();
		const existing = this.buckets.get(key);
		// Fixed window: the first attempt after the window closes opens a new one.
		const bucket = existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + windowMs };
		bucket.count += 1;
		this.buckets.set(key, bucket);
		// Opportunistic sweep — a login route sees few enough keys that this
		// never walks a big map, and it keeps the process from growing forever.
		if (this.buckets.size > 1000) {
			for (const [candidate, value] of this.buckets) if (value.resetAt <= now) this.buckets.delete(candidate);
		}
		return { ...bucket };
	}

	async clear(key: string): Promise<void> {
		this.buckets.delete(key);
	}
}

let backend: ThrottleBackend = new MemoryThrottle();

/** Swap the counter — e.g. for a Redis-backed one in a multi-replica deployment. */
export function setThrottleBackend(next: ThrottleBackend): void {
	backend = next;
}

/** Test-only: back to a fresh in-process counter. */
export function _resetThrottle(): void {
	backend = new MemoryThrottle();
}

export interface ThrottleVerdict {
	/** `false` once the limit is exceeded inside the window. */
	allowed: boolean;
	/** Attempts recorded in the current window, this one included. */
	count: number;
	/** Seconds until the window closes. `0` while allowed. */
	retryAfter: number;
}

/**
 * Record an attempt and say whether it may proceed.
 *
 * Call it BEFORE verifying the password — the point is to bound how many
 * guesses an attacker gets, so a rejected attempt must not cost a hash.
 */
export async function hitThrottle(
	key: string,
	opts: { limit?: number; windowSeconds?: number } = {},
): Promise<ThrottleVerdict> {
	const limit = opts.limit ?? 5;
	const windowMs = (opts.windowSeconds ?? 60) * 1000;
	const { count, resetAt } = await backend.hit(key, windowMs);
	const allowed = count <= limit;
	return { allowed, count, retryAfter: allowed ? 0 : Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)) };
}

/** Forget a key. Called on a successful login so a legitimate user is not punished. */
export async function clearThrottle(key: string): Promise<void> {
	await backend.clear(key);
}

/**
 * The bucket key for one login attempt: client IP + the address being tried.
 *
 * The IP comes from `X-Forwarded-For`'s first entry when present (the client as
 * the closest proxy saw it), else the socket address the trigger recorded, else
 * a constant — an unknown IP still gets throttled, just together with every
 * other unknown one.
 */
export function throttleKey(headers: Record<string, unknown> | undefined, email: string): string {
	const forwarded = headers?.["x-forwarded-for"];
	const direct = headers?.["x-real-ip"] ?? headers?.["cf-connecting-ip"];
	const ip =
		(typeof forwarded === "string" && forwarded.split(",")[0]?.trim()) ||
		(typeof direct === "string" ? direct : "") ||
		"unknown";
	return `${ip}|${String(email).trim().toLowerCase()}`;
}
