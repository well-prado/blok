/**
 * Node Result Caching for Blok Runner
 *
 * Provides intelligent caching of node execution results to avoid redundant
 * computation. Supports LRU eviction, TTL-based expiry, tag-based invalidation,
 * and pluggable cache providers.
 *
 * Uses only Node.js built-ins (node:crypto for hashing).
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Interfaces & Types
// ---------------------------------------------------------------------------

/**
 * A pluggable cache storage backend. Implementations must be safe for
 * concurrent async access (no overlapping mutations on the same key).
 */
export interface CacheProvider {
	/** Human-readable name of the provider (e.g. "in-memory", "redis"). */
	readonly name: string;

	/** Retrieve a cached entry, or `null` if the key is absent / expired. */
	get<T>(key: string): Promise<CacheEntry<T> | null>;

	/** Store a value under `key` with optional TTL, tags, and priority. */
	set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void>;

	/** Remove a single key. Returns `true` if the key existed. */
	delete(key: string): Promise<boolean>;

	/** Remove *all* entries from the cache. */
	clear(): Promise<void>;

	/** Check existence without bumping LRU order. */
	has(key: string): Promise<boolean>;

	/** Return a snapshot of hit/miss statistics. */
	getStats(): CacheStats;
}

/** A single cached value together with its metadata. */
export interface CacheEntry<T> {
	/** The cached value. */
	value: T;
	/** The cache key under which this entry is stored. */
	key: string;
	/** Unix-epoch ms when the entry was written. */
	createdAt: number;
	/** Unix-epoch ms when the entry will be considered expired. */
	expiresAt: number;
	/** Number of times this entry has been read from cache. */
	hits: number;
	/** Approximate size in bytes (derived from JSON.stringify length). */
	size: number;
}

/** Options accepted by {@link CacheProvider.set}. */
export interface CacheSetOptions {
	/** Time-to-live in milliseconds. Defaults to 60 000 (60 s). */
	ttlMs?: number;
	/** Arbitrary string tags for bulk invalidation via {@link InMemoryCache.invalidateByTag}. */
	tags?: string[];
	/** Eviction priority. Higher values are evicted later. Default: 0. */
	priority?: number;
}

/** Aggregate cache performance statistics. */
export interface CacheStats {
	/** Total cache hits. */
	hits: number;
	/** Total cache misses. */
	misses: number;
	/** Current number of entries in the cache. */
	size: number;
	/** Maximum number of entries allowed. */
	maxSize: number;
	/** Hit rate as a ratio (0-1). Returns 0 when no requests have been made. */
	hitRate: number;
	/** Number of entries evicted (LRU or TTL). */
	evictions: number;
	/** Total number of `set` calls. */
	totalSets: number;
	/** Approximate memory consumed by cached values, in bytes. */
	memoryUsageBytes: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Internal wrapper stored inside {@link InMemoryCache}. */
interface InternalEntry<T> {
	entry: CacheEntry<T>;
	tags: string[];
	priority: number;
}

/**
 * Estimate the byte-size of an arbitrary value by serialising it to JSON.
 * Falls back to 0 for values that cannot be serialised.
 */
function estimateSize(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf-8");
	} catch {
		return 0;
	}
}

/**
 * Produce a deterministic SHA-256 hex digest for a cache key string.
 */
function sha256(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// InMemoryCache
// ---------------------------------------------------------------------------

/** Configuration for {@link InMemoryCache}. */
export interface InMemoryCacheConfig {
	/** Maximum number of entries before LRU eviction kicks in. Default: 500. */
	maxSize?: number;
	/** Default TTL in milliseconds when none is provided on `set`. Default: 60 000. */
	defaultTTLMs?: number;
	/** Maximum aggregate byte size of cached values. Default: 50 MB. */
	maxMemoryBytes?: number;
	/** Optional callback invoked whenever an entry is evicted. */
	onEvict?: (key: string, reason: "lru" | "ttl" | "memory" | "manual") => void;
}

const DEFAULT_MAX_SIZE = 500;
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_MEMORY_BYTES = 50 * 1024 * 1024; // 50 MB
const SWEEP_INTERVAL_MS = 60_000; // 60 s

/**
 * LRU cache with TTL-based expiry, tag-based invalidation, and memory limits.
 *
 * Internally backed by a `Map` whose insertion order is used for LRU tracking.
 * Every `get` promotes the accessed key to the most-recently-used position.
 *
 * Expired entries are cleaned up lazily on access and periodically via a
 * background sweep timer (every 60 s).  The timer is `unref`-ed so it does
 * not prevent the Node.js process from exiting.
 */
export class InMemoryCache implements CacheProvider {
	readonly name = "in-memory";

	private readonly store: Map<string, InternalEntry<unknown>> = new Map();
	private readonly maxSize: number;
	private readonly defaultTTLMs: number;
	private readonly maxMemoryBytes: number;
	private readonly onEvict?: (key: string, reason: "lru" | "ttl" | "memory" | "manual") => void;

	private _hits = 0;
	private _misses = 0;
	private _evictions = 0;
	private _totalSets = 0;
	private _memoryUsageBytes = 0;

	private sweepTimer: ReturnType<typeof setInterval> | null = null;

	constructor(config: InMemoryCacheConfig = {}) {
		this.maxSize = config.maxSize ?? DEFAULT_MAX_SIZE;
		this.defaultTTLMs = config.defaultTTLMs ?? DEFAULT_TTL_MS;
		this.maxMemoryBytes = config.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES;
		this.onEvict = config.onEvict;

		this.startPeriodicSweep();
	}

	// -- CacheProvider implementation ----------------------------------------

	/** @inheritdoc */
	async get<T>(key: string): Promise<CacheEntry<T> | null> {
		const internal = this.store.get(key) as InternalEntry<T> | undefined;

		if (!internal) {
			this._misses++;
			return null;
		}

		// Lazy TTL check
		if (Date.now() >= internal.entry.expiresAt) {
			this.evict(key, "ttl");
			this._misses++;
			return null;
		}

		// Promote to most-recently-used (re-insert at the end of the Map)
		this.store.delete(key);
		internal.entry.hits++;
		this.store.set(key, internal);

		this._hits++;
		return { ...internal.entry };
	}

	/** @inheritdoc */
	async set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void> {
		this._totalSets++;

		const ttlMs = options?.ttlMs ?? this.defaultTTLMs;
		const tags = options?.tags ?? [];
		const priority = options?.priority ?? 0;
		const size = estimateSize(value);
		const now = Date.now();

		// If the key already exists, remove it first so the new entry goes to
		// the end of the Map (most-recently-used position).
		const existing = this.store.get(key);
		if (existing) {
			this._memoryUsageBytes -= existing.entry.size;
			this.store.delete(key);
		}

		const entry: CacheEntry<T> = {
			value,
			key,
			createdAt: now,
			expiresAt: now + ttlMs,
			hits: 0,
			size,
		};

		const internal: InternalEntry<T> = { entry, tags, priority };
		this.store.set(key, internal as InternalEntry<unknown>);
		this._memoryUsageBytes += size;

		// Enforce memory limit
		this.enforceMemoryLimit();

		// Enforce max-size limit via LRU eviction
		this.enforceSizeLimit();
	}

	/** @inheritdoc */
	async delete(key: string): Promise<boolean> {
		return this.evict(key, "manual");
	}

	/** @inheritdoc */
	async clear(): Promise<void> {
		this.store.clear();
		this._memoryUsageBytes = 0;
	}

	/** @inheritdoc */
	async has(key: string): Promise<boolean> {
		const internal = this.store.get(key);
		if (!internal) return false;
		if (Date.now() >= internal.entry.expiresAt) {
			this.evict(key, "ttl");
			return false;
		}
		return true;
	}

	/** @inheritdoc */
	getStats(): CacheStats {
		const total = this._hits + this._misses;
		return {
			hits: this._hits,
			misses: this._misses,
			size: this.store.size,
			maxSize: this.maxSize,
			hitRate: total === 0 ? 0 : this._hits / total,
			evictions: this._evictions,
			totalSets: this._totalSets,
			memoryUsageBytes: this._memoryUsageBytes,
		};
	}

	// -- Extended API --------------------------------------------------------

	/**
	 * Remove all entries that carry the given tag.
	 *
	 * @param tag - Tag string to match against.
	 * @returns Number of entries removed.
	 */
	invalidateByTag(tag: string): number {
		let count = 0;
		const entries = Array.from(this.store.entries());
		for (const [key, internal] of entries) {
			if (internal.tags.includes(tag)) {
				this.evict(key, "manual");
				count++;
			}
		}
		return count;
	}

	/**
	 * Stop the periodic sweep timer and release resources.
	 * Call this when the cache is no longer needed.
	 */
	destroy(): void {
		this.stopPeriodicSweep();
		this.store.clear();
		this._memoryUsageBytes = 0;
	}

	// -- Private helpers -----------------------------------------------------

	/**
	 * Evict a single key from the cache.
	 *
	 * @returns `true` if the key existed and was removed.
	 */
	private evict(key: string, reason: "lru" | "ttl" | "memory" | "manual"): boolean {
		const internal = this.store.get(key);
		if (!internal) return false;

		this.store.delete(key);
		this._memoryUsageBytes -= internal.entry.size;
		this._evictions++;

		if (this.onEvict) {
			try {
				this.onEvict(key, reason);
			} catch {
				// Eviction callbacks must not throw into the hot path.
			}
		}

		return true;
	}

	/**
	 * Evict the least-recently-used entries until `store.size <= maxSize`.
	 * Entries with higher priority are skipped in favour of lower-priority ones.
	 */
	private enforceSizeLimit(): void {
		while (this.store.size > this.maxSize) {
			// Find the entry with the lowest priority among the oldest entries
			let lowestKey: string | null = null;
			let lowestPriority = Infinity;

			const entries = Array.from(this.store.entries());
			for (const [key, internal] of entries) {
				if (internal.priority < lowestPriority) {
					lowestPriority = internal.priority;
					lowestKey = key;
				}
				// Only inspect the oldest quarter (those at the front of the Map)
				// to keep eviction fast while still respecting priority.
				if (lowestKey !== null && lowestPriority === 0) break;
			}

			if (lowestKey !== null) {
				this.evict(lowestKey, "lru");
			} else {
				// Safety valve: evict the first (oldest) key.
				const keys = Array.from(this.store.keys());
				if (keys.length > 0) {
					this.evict(keys[0], "lru");
				}
			}
		}
	}

	/**
	 * Evict entries until `_memoryUsageBytes <= maxMemoryBytes`.
	 */
	private enforceMemoryLimit(): void {
		while (this._memoryUsageBytes > this.maxMemoryBytes && this.store.size > 0) {
			const keys = Array.from(this.store.keys());
			if (keys.length === 0) break;
			this.evict(keys[0], "memory");
		}
	}

	/**
	 * Sweep all expired entries.  Called periodically by the background timer.
	 */
	private sweep(): void {
		const now = Date.now();
		const entries = Array.from(this.store.entries());
		for (const [key, internal] of entries) {
			if (now >= internal.entry.expiresAt) {
				this.evict(key, "ttl");
			}
		}
	}

	private startPeriodicSweep(): void {
		this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
		if (this.sweepTimer.unref) {
			this.sweepTimer.unref();
		}
	}

	private stopPeriodicSweep(): void {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}
	}
}

// ---------------------------------------------------------------------------
// Cache Key Strategies
// ---------------------------------------------------------------------------

/** Strategy used by {@link NodeResultCache} to derive cache keys. */
export type CacheKeyStrategy = "input-hash" | "node-input" | "custom";

/** Custom key generation function. */
export type CustomKeyFn = (nodeName: string, input: unknown) => string;

// ---------------------------------------------------------------------------
// NodeResultCache
// ---------------------------------------------------------------------------

/** The value returned by {@link NodeResultCache.wrapExecution}. */
export interface CacheResult<O> {
	/** The execution output (from cache or freshly computed). */
	data: O;
	/** `true` when the result was served from cache. */
	cached: boolean;
	/** The cache key used for this lookup. */
	key: string;
	/** Milliseconds remaining before this entry expires (only when `cached` is true). */
	ttlRemainingMs?: number;
}

/** Configuration for {@link NodeResultCache}. */
export interface NodeResultCacheConfig {
	/** The cache provider to use. Defaults to a new {@link InMemoryCache}. */
	provider?: CacheProvider;
	/** Whether caching is enabled. Default: `true`. */
	enabled?: boolean;
	/** Strategy for generating cache keys. Default: `"node-input"`. */
	keyStrategy?: CacheKeyStrategy;
	/** Required when `keyStrategy` is `"custom"`. */
	customKeyFn?: CustomKeyFn;
}

/**
 * Singleton orchestrator that wraps node executions with transparent caching.
 *
 * Typical usage:
 *
 * ```ts
 * const cache = NodeResultCache.getInstance();
 *
 * const result = await cache.wrapExecution("myNode", input, async () => {
 *   return expensiveComputation(input);
 * });
 *
 * console.log(result.cached); // true on subsequent identical calls
 * ```
 *
 * The singleton is configured once via {@link NodeResultCache.configure}.
 * Subsequent calls to `getInstance()` return the already-configured instance.
 */
export class NodeResultCache {
	private static instance: NodeResultCache | null = null;

	private readonly provider: CacheProvider;
	private readonly enabled: boolean;
	private readonly keyStrategy: CacheKeyStrategy;
	private readonly customKeyFn?: CustomKeyFn;

	/**
	 * In-flight promise map for deduplicating concurrent executions of the
	 * same cache key.  Prevents the "thundering herd" problem where N
	 * concurrent callers all compute the same expensive result.
	 */
	private readonly inflight: Map<string, Promise<unknown>> = new Map();

	private constructor(config: NodeResultCacheConfig = {}) {
		this.provider = config.provider ?? new InMemoryCache();
		this.enabled = config.enabled ?? true;
		this.keyStrategy = config.keyStrategy ?? "node-input";
		this.customKeyFn = config.customKeyFn;

		if (this.keyStrategy === "custom" && typeof this.customKeyFn !== "function") {
			throw new Error(
				'NodeResultCache: "custom" key strategy requires a customKeyFn to be provided.',
			);
		}
	}

	// -- Singleton API -------------------------------------------------------

	/**
	 * Return the singleton instance, creating one with defaults if necessary.
	 */
	static getInstance(): NodeResultCache {
		if (!NodeResultCache.instance) {
			NodeResultCache.instance = new NodeResultCache();
		}
		return NodeResultCache.instance;
	}

	/**
	 * Create (or replace) the singleton with the given configuration.
	 *
	 * @returns The newly configured singleton instance.
	 */
	static configure(config: NodeResultCacheConfig): NodeResultCache {
		// If an existing instance has a destroyable provider, clean it up.
		if (NodeResultCache.instance) {
			const oldProvider = NodeResultCache.instance.provider;
			if (oldProvider instanceof InMemoryCache) {
				oldProvider.destroy();
			}
		}
		NodeResultCache.instance = new NodeResultCache(config);
		return NodeResultCache.instance;
	}

	/**
	 * Tear down the singleton, releasing any resources held by the provider.
	 */
	static resetInstance(): void {
		if (NodeResultCache.instance) {
			const provider = NodeResultCache.instance.provider;
			if (provider instanceof InMemoryCache) {
				provider.destroy();
			}
			NodeResultCache.instance = null;
		}
	}

	// -- Public API ----------------------------------------------------------

	/**
	 * Wrap an async execution with caching.
	 *
	 * If a cached result exists for the derived key it is returned immediately.
	 * Otherwise `execute` is invoked and its result is stored before being
	 * returned.
	 *
	 * Concurrent calls with the same key will share a single in-flight
	 * execution (request coalescing).
	 *
	 * @param nodeName - Logical name of the node being executed.
	 * @param input    - The input payload used to derive the cache key.
	 * @param execute  - Factory that produces the result when no cache hit.
	 * @param options  - Optional TTL, tags, and priority for the cache entry.
	 * @returns A {@link CacheResult} indicating whether the result was cached.
	 */
	async wrapExecution<I, O>(
		nodeName: string,
		input: I,
		execute: () => Promise<O>,
		options?: CacheSetOptions,
	): Promise<CacheResult<O>> {
		const key = this.buildKey(nodeName, input);

		// Bypass cache entirely when disabled.
		if (!this.enabled) {
			const data = await execute();
			return { data, cached: false, key };
		}

		// 1. Check for a cached entry.
		const cached = await this.provider.get<O>(key);
		if (cached) {
			return {
				data: cached.value,
				cached: true,
				key,
				ttlRemainingMs: Math.max(0, cached.expiresAt - Date.now()),
			};
		}

		// 2. Deduplicate concurrent executions for the same key.
		const existing = this.inflight.get(key);
		if (existing) {
			const data = (await existing) as O;
			// By this point the first caller will have stored the result.
			const entry = await this.provider.get<O>(key);
			return {
				data,
				cached: entry !== null,
				key,
				ttlRemainingMs: entry ? Math.max(0, entry.expiresAt - Date.now()) : undefined,
			};
		}

		// 3. Execute and cache.
		const promise = execute();
		this.inflight.set(key, promise);

		try {
			const data = await promise;
			await this.provider.set<O>(key, data, options);
			return { data, cached: false, key };
		} finally {
			this.inflight.delete(key);
		}
	}

	/**
	 * Invalidate all cache entries whose key starts with the node-specific
	 * prefix.  This is only fully effective with the default `"node-input"`
	 * strategy and the built-in {@link InMemoryCache} provider.
	 *
	 * For external providers, consider using tag-based invalidation instead.
	 *
	 * @param nodeName - Name of the node whose results should be purged.
	 */
	async invalidateNode(nodeName: string): Promise<void> {
		if (this.provider instanceof InMemoryCache) {
			const prefix = `node:${nodeName}:`;
			const store = (this.provider as unknown as { store: Map<string, unknown> }).store;
			const keysToDelete: string[] = [];
			const allKeys = Array.from(store.keys());
			for (const key of allKeys) {
				if (key.startsWith(prefix)) {
					keysToDelete.push(key);
				}
			}
			for (const key of keysToDelete) {
				await this.provider.delete(key);
			}
		} else {
			// For external providers: best-effort tag invalidation.
			await this.invalidateByTags([`node:${nodeName}`]);
		}
	}

	/**
	 * Invalidate all entries matching *any* of the supplied tags.
	 *
	 * This is a convenience wrapper around {@link InMemoryCache.invalidateByTag}
	 * when the built-in provider is used.
	 *
	 * @param tags - Array of tag strings.
	 */
	async invalidateByTags(tags: string[]): Promise<void> {
		if (this.provider instanceof InMemoryCache) {
			for (const tag of tags) {
				this.provider.invalidateByTag(tag);
			}
		}
		// External providers would need their own tag invalidation mechanism.
	}

	/**
	 * Pre-populate the cache for a set of known inputs.
	 *
	 * This is useful during application startup to "warm" the cache and
	 * ensure that the first real request for each input is served from cache.
	 *
	 * @param nodeName - Name of the node.
	 * @param inputs   - Array of inputs to pre-compute.
	 * @param execute  - Factory that computes the result for a given input.
	 * @param options  - Optional cache-set options applied to every entry.
	 */
	async warmup<I, O>(
		nodeName: string,
		inputs: I[],
		execute: (input: I) => Promise<O>,
		options?: CacheSetOptions,
	): Promise<void> {
		await Promise.all(
			inputs.map(async (input) => {
				const key = this.buildKey(nodeName, input);
				const exists = await this.provider.has(key);
				if (!exists) {
					const result = await execute(input);
					await this.provider.set<O>(key, result, options);
				}
			}),
		);
	}

	/**
	 * Return the underlying provider's statistics snapshot.
	 */
	getStats(): CacheStats {
		return this.provider.getStats();
	}

	/**
	 * Return the underlying cache provider instance.
	 */
	getProvider(): CacheProvider {
		return this.provider;
	}

	// -- Private helpers -----------------------------------------------------

	/**
	 * Derive a cache key from the node name and input based on the configured
	 * {@link CacheKeyStrategy}.
	 */
	private buildKey(nodeName: string, input: unknown): string {
		switch (this.keyStrategy) {
			case "input-hash":
				return sha256(JSON.stringify(input));
			case "node-input":
				return `node:${nodeName}:${sha256(nodeName + JSON.stringify(input))}`;
			case "custom":
				return this.customKeyFn!(nodeName, input);
			default:
				return `node:${nodeName}:${sha256(nodeName + JSON.stringify(input))}`;
		}
	}
}
