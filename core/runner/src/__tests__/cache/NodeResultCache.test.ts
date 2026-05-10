import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCache, NodeResultCache } from "../../cache/NodeResultCache";

// ---------------------------------------------------------------------------
// InMemoryCache
// ---------------------------------------------------------------------------

describe("InMemoryCache", () => {
	let cache: InMemoryCache;

	beforeEach(() => {
		cache = new InMemoryCache({ maxSize: 100, defaultTTLMs: 5_000 });
	});

	afterEach(() => {
		cache.destroy();
	});

	// -- Basic set / get ----------------------------------------------------

	describe("set and get", () => {
		it("should store and retrieve a value", async () => {
			await cache.set("key1", { name: "Alice" });
			const entry = await cache.get<{ name: string }>("key1");
			expect(entry).not.toBeNull();
			expect(entry!.value).toEqual({ name: "Alice" });
			expect(entry!.key).toBe("key1");
		});

		it("should return null for a missing key", async () => {
			const entry = await cache.get("nonexistent");
			expect(entry).toBeNull();
		});

		it("should overwrite an existing key", async () => {
			await cache.set("key1", "first");
			await cache.set("key1", "second");
			const entry = await cache.get<string>("key1");
			expect(entry!.value).toBe("second");
		});

		it("should track hit count on the entry", async () => {
			await cache.set("key1", "value");
			await cache.get("key1");
			await cache.get("key1");
			const entry = await cache.get("key1");
			// After 3 gets, entry.hits should be 3 (each get increments before returning)
			expect(entry!.hits).toBe(3);
		});

		it("should record createdAt and expiresAt timestamps", async () => {
			const before = Date.now();
			await cache.set("key1", "value", { ttlMs: 10_000 });
			const after = Date.now();
			const entry = await cache.get("key1");
			expect(entry!.createdAt).toBeGreaterThanOrEqual(before);
			expect(entry!.createdAt).toBeLessThanOrEqual(after);
			expect(entry!.expiresAt).toBeGreaterThanOrEqual(before + 10_000);
			expect(entry!.expiresAt).toBeLessThanOrEqual(after + 10_000);
		});

		it("should estimate the size of the cached value", async () => {
			await cache.set("key1", { data: "hello" });
			const entry = await cache.get("key1");
			expect(entry!.size).toBeGreaterThan(0);
		});
	});

	// -- TTL expiration -----------------------------------------------------

	describe("TTL expiration", () => {
		it("should expire entries after ttlMs via get()", async () => {
			vi.useFakeTimers();
			try {
				const ttlCache = new InMemoryCache({ defaultTTLMs: 100 });
				await ttlCache.set("key1", "value");
				expect(await ttlCache.get("key1")).not.toBeNull();

				vi.advanceTimersByTime(101);
				expect(await ttlCache.get("key1")).toBeNull();
				ttlCache.destroy();
			} finally {
				vi.useRealTimers();
			}
		});

		it("should expire entries after ttlMs via has()", async () => {
			vi.useFakeTimers();
			try {
				const ttlCache = new InMemoryCache({ defaultTTLMs: 100 });
				await ttlCache.set("key1", "value");
				expect(await ttlCache.has("key1")).toBe(true);

				vi.advanceTimersByTime(101);
				expect(await ttlCache.has("key1")).toBe(false);
				ttlCache.destroy();
			} finally {
				vi.useRealTimers();
			}
		});

		it("should use per-entry ttlMs when provided", async () => {
			vi.useFakeTimers();
			try {
				const ttlCache = new InMemoryCache({ defaultTTLMs: 10_000 });
				await ttlCache.set("short", "val", { ttlMs: 50 });
				await ttlCache.set("long", "val", { ttlMs: 5_000 });

				vi.advanceTimersByTime(51);
				expect(await ttlCache.get("short")).toBeNull();
				expect(await ttlCache.get("long")).not.toBeNull();
				ttlCache.destroy();
			} finally {
				vi.useRealTimers();
			}
		});

		it("should count expired-on-access as a miss", async () => {
			vi.useFakeTimers();
			try {
				const ttlCache = new InMemoryCache({ defaultTTLMs: 50 });
				await ttlCache.set("key1", "value");

				vi.advanceTimersByTime(51);
				await ttlCache.get("key1");

				const stats = ttlCache.getStats();
				expect(stats.misses).toBe(1);
				expect(stats.hits).toBe(0);
				ttlCache.destroy();
			} finally {
				vi.useRealTimers();
			}
		});
	});

	// -- Max size / LRU eviction --------------------------------------------

	describe("max size eviction (LRU)", () => {
		it("should evict entries when max size is exceeded", async () => {
			const small = new InMemoryCache({ maxSize: 3, defaultTTLMs: 60_000 });
			await small.set("a", 1);
			await small.set("b", 2);
			await small.set("c", 3);
			// This should evict the oldest (LRU) entry
			await small.set("d", 4);

			const stats = small.getStats();
			expect(stats.size).toBe(3);
			expect(stats.evictions).toBeGreaterThanOrEqual(1);
			small.destroy();
		});

		it("should evict the least recently used entry", async () => {
			const small = new InMemoryCache({ maxSize: 3, defaultTTLMs: 60_000 });
			await small.set("a", 1);
			await small.set("b", 2);
			await small.set("c", 3);

			// Access "a" to make it recently used
			await small.get("a");

			// Insert "d" -- should evict "b" (LRU, not "a")
			await small.set("d", 4);

			expect(await small.has("a")).toBe(true);
			expect(await small.has("b")).toBe(false);
			expect(await small.has("c")).toBe(true);
			expect(await small.has("d")).toBe(true);
			small.destroy();
		});

		it("should record evictions in stats", async () => {
			const small = new InMemoryCache({ maxSize: 2, defaultTTLMs: 60_000 });
			await small.set("a", 1);
			await small.set("b", 2);
			await small.set("c", 3);
			await small.set("d", 4);

			const stats = small.getStats();
			expect(stats.evictions).toBe(2);
			expect(stats.size).toBe(2);
			small.destroy();
		});
	});

	// -- delete -------------------------------------------------------------

	describe("delete", () => {
		it("should remove an existing key and return true", async () => {
			await cache.set("key1", "value");
			const deleted = await cache.delete("key1");
			expect(deleted).toBe(true);
			expect(await cache.get("key1")).toBeNull();
		});

		it("should return false for a non-existent key", async () => {
			const deleted = await cache.delete("nonexistent");
			expect(deleted).toBe(false);
		});

		it("should update stats after deletion", async () => {
			await cache.set("key1", "value");
			await cache.delete("key1");
			const stats = cache.getStats();
			expect(stats.size).toBe(0);
			// delete counts as an eviction (reason: "manual")
			expect(stats.evictions).toBe(1);
		});
	});

	// -- clear --------------------------------------------------------------

	describe("clear", () => {
		it("should remove all entries", async () => {
			await cache.set("a", 1);
			await cache.set("b", 2);
			await cache.set("c", 3);
			await cache.clear();
			const stats = cache.getStats();
			expect(stats.size).toBe(0);
		});

		it("should reset memory usage to 0", async () => {
			await cache.set("a", { big: "x".repeat(1000) });
			await cache.clear();
			expect(cache.getStats().memoryUsageBytes).toBe(0);
		});
	});

	// -- has ----------------------------------------------------------------

	describe("has", () => {
		it("should return true for an existing non-expired key", async () => {
			await cache.set("key1", "value");
			expect(await cache.has("key1")).toBe(true);
		});

		it("should return false for a missing key", async () => {
			expect(await cache.has("nonexistent")).toBe(false);
		});

		it("should return false for an expired key", async () => {
			vi.useFakeTimers();
			try {
				const ttlCache = new InMemoryCache({ defaultTTLMs: 50 });
				await ttlCache.set("key1", "value");
				vi.advanceTimersByTime(51);
				expect(await ttlCache.has("key1")).toBe(false);
				ttlCache.destroy();
			} finally {
				vi.useRealTimers();
			}
		});
	});

	// -- getStats -----------------------------------------------------------

	describe("getStats", () => {
		it("should return initial stats for a fresh cache", () => {
			const stats = cache.getStats();
			expect(stats.hits).toBe(0);
			expect(stats.misses).toBe(0);
			expect(stats.size).toBe(0);
			expect(stats.maxSize).toBe(100);
			expect(stats.hitRate).toBe(0);
			expect(stats.evictions).toBe(0);
			expect(stats.totalSets).toBe(0);
			expect(stats.memoryUsageBytes).toBe(0);
		});

		it("should track hits and misses correctly", async () => {
			await cache.set("key1", "value");
			await cache.get("key1"); // hit
			await cache.get("key1"); // hit
			await cache.get("missing"); // miss

			const stats = cache.getStats();
			expect(stats.hits).toBe(2);
			expect(stats.misses).toBe(1);
		});

		it("should compute hitRate correctly", async () => {
			await cache.set("key1", "value");
			await cache.get("key1"); // hit
			await cache.get("missing"); // miss

			const stats = cache.getStats();
			expect(stats.hitRate).toBeCloseTo(0.5, 5);
		});

		it("should track totalSets", async () => {
			await cache.set("a", 1);
			await cache.set("b", 2);
			await cache.set("a", 3); // overwrite counts as another set
			expect(cache.getStats().totalSets).toBe(3);
		});

		it("should track memoryUsageBytes", async () => {
			await cache.set("key1", { data: "hello world" });
			const stats = cache.getStats();
			expect(stats.memoryUsageBytes).toBeGreaterThan(0);
		});

		it("should decrease memoryUsageBytes when entries are deleted", async () => {
			await cache.set("key1", { data: "hello world" });
			const beforeDelete = cache.getStats().memoryUsageBytes;
			await cache.delete("key1");
			expect(cache.getStats().memoryUsageBytes).toBeLessThan(beforeDelete);
		});
	});

	// -- Tag-based invalidation ---------------------------------------------

	describe("invalidateByTag", () => {
		it("should invalidate entries matching the given tag", async () => {
			await cache.set("a", 1, { tags: ["group1"] });
			await cache.set("b", 2, { tags: ["group1", "group2"] });
			await cache.set("c", 3, { tags: ["group2"] });

			const count = cache.invalidateByTag("group1");
			expect(count).toBe(2);
			expect(await cache.has("a")).toBe(false);
			expect(await cache.has("b")).toBe(false);
			expect(await cache.has("c")).toBe(true);
		});

		it("should return 0 when no entries match the tag", async () => {
			await cache.set("a", 1, { tags: ["group1"] });
			const count = cache.invalidateByTag("no-match");
			expect(count).toBe(0);
		});

		it("should handle entries with no tags", async () => {
			await cache.set("a", 1);
			await cache.set("b", 2, { tags: ["tagged"] });

			const count = cache.invalidateByTag("tagged");
			expect(count).toBe(1);
			expect(await cache.has("a")).toBe(true);
			expect(await cache.has("b")).toBe(false);
		});
	});

	// -- Priority-aware eviction --------------------------------------------

	describe("priority-aware eviction", () => {
		it("should evict lower priority entries before higher priority ones", async () => {
			const small = new InMemoryCache({ maxSize: 3, defaultTTLMs: 60_000 });
			await small.set("low", "low-val", { priority: 0 });
			await small.set("mid", "mid-val", { priority: 5 });
			await small.set("high", "high-val", { priority: 10 });

			// Force eviction by adding a fourth entry
			await small.set("new", "new-val", { priority: 0 });

			// The lowest priority entry "low" should be evicted
			expect(await small.has("low")).toBe(false);
			expect(await small.has("mid")).toBe(true);
			expect(await small.has("high")).toBe(true);
			expect(await small.has("new")).toBe(true);
			small.destroy();
		});

		it("should evict multiple low-priority entries when needed", async () => {
			const small = new InMemoryCache({ maxSize: 2, defaultTTLMs: 60_000 });
			await small.set("low1", "val1", { priority: 0 });
			await small.set("low2", "val2", { priority: 0 });

			// These two additions should evict the two low-priority entries
			await small.set("high1", "val3", { priority: 10 });
			// Now cache has: low2, high1 -- low1 evicted
			await small.set("high2", "val4", { priority: 10 });
			// Now cache should have: high1, high2 -- low2 evicted

			expect(await small.has("low1")).toBe(false);
			expect(await small.has("low2")).toBe(false);
			expect(await small.has("high1")).toBe(true);
			expect(await small.has("high2")).toBe(true);
			small.destroy();
		});
	});

	// -- destroy ------------------------------------------------------------

	describe("destroy", () => {
		it("should stop the sweep timer and clear all entries", async () => {
			await cache.set("key1", "value");
			cache.destroy();
			// After destroy, the store is cleared
			const stats = cache.getStats();
			expect(stats.size).toBe(0);
			expect(stats.memoryUsageBytes).toBe(0);
		});

		it("should be safe to call destroy multiple times", () => {
			cache.destroy();
			cache.destroy();
			// No error thrown
		});
	});

	// -- onEvict callback ---------------------------------------------------

	describe("onEvict callback", () => {
		it("should invoke onEvict when an entry is evicted via delete", async () => {
			const evicted: Array<{ key: string; reason: string }> = [];
			const callbackCache = new InMemoryCache({
				maxSize: 100,
				defaultTTLMs: 60_000,
				onEvict: (key, reason) => evicted.push({ key, reason }),
			});

			await callbackCache.set("key1", "value");
			await callbackCache.delete("key1");

			expect(evicted).toEqual([{ key: "key1", reason: "manual" }]);
			callbackCache.destroy();
		});

		it("should invoke onEvict with reason 'lru' during size eviction", async () => {
			const evicted: Array<{ key: string; reason: string }> = [];
			const callbackCache = new InMemoryCache({
				maxSize: 2,
				defaultTTLMs: 60_000,
				onEvict: (key, reason) => evicted.push({ key, reason }),
			});

			await callbackCache.set("a", 1);
			await callbackCache.set("b", 2);
			await callbackCache.set("c", 3); // triggers eviction of "a"

			expect(evicted.length).toBe(1);
			expect(evicted[0].reason).toBe("lru");
			callbackCache.destroy();
		});

		it("should invoke onEvict with reason 'ttl' when expired entry is accessed", async () => {
			vi.useFakeTimers();
			try {
				const evicted: Array<{ key: string; reason: string }> = [];
				const callbackCache = new InMemoryCache({
					defaultTTLMs: 50,
					onEvict: (key, reason) => evicted.push({ key, reason }),
				});

				await callbackCache.set("key1", "value");
				vi.advanceTimersByTime(51);
				await callbackCache.get("key1"); // triggers TTL eviction

				expect(evicted).toEqual([{ key: "key1", reason: "ttl" }]);
				callbackCache.destroy();
			} finally {
				vi.useRealTimers();
			}
		});
	});

	// -- Memory limit -------------------------------------------------------

	describe("memory limit", () => {
		it("should evict entries when memory limit is exceeded", async () => {
			const tinyCache = new InMemoryCache({
				maxSize: 1000,
				defaultTTLMs: 60_000,
				maxMemoryBytes: 100, // very small memory limit
			});

			// Insert a large entry that exceeds the limit
			const largeValue = "x".repeat(200);
			await tinyCache.set("big", largeValue);
			// Now insert another entry -- memory enforcement should kick in
			await tinyCache.set("small", "y");

			const stats = tinyCache.getStats();
			// The cache may have evicted entries to stay within memory
			expect(stats.memoryUsageBytes).toBeLessThanOrEqual(200);
			tinyCache.destroy();
		});
	});

	// -- Name ---------------------------------------------------------------

	describe("name", () => {
		it("should report its name as 'in-memory'", () => {
			expect(cache.name).toBe("in-memory");
		});
	});
});

// ---------------------------------------------------------------------------
// NodeResultCache (singleton)
// ---------------------------------------------------------------------------

describe("NodeResultCache", () => {
	beforeEach(() => {
		NodeResultCache.resetInstance();
	});

	afterEach(() => {
		NodeResultCache.resetInstance();
	});

	// -- Singleton API ------------------------------------------------------

	describe("getInstance", () => {
		it("should return the same instance on repeated calls", () => {
			const a = NodeResultCache.getInstance();
			const b = NodeResultCache.getInstance();
			expect(a).toBe(b);
		});

		it("should create an instance with default configuration", () => {
			const instance = NodeResultCache.getInstance();
			const stats = instance.getStats();
			expect(stats.maxSize).toBe(500); // default from InMemoryCache
		});
	});

	describe("configure", () => {
		it("should create a new instance with the given configuration", () => {
			const provider = new InMemoryCache({ maxSize: 10 });
			const instance = NodeResultCache.configure({ provider });
			expect(instance.getStats().maxSize).toBe(10);
			provider.destroy();
		});

		it("should replace the existing singleton", () => {
			const first = NodeResultCache.getInstance();
			const provider = new InMemoryCache({ maxSize: 42 });
			const second = NodeResultCache.configure({ provider });
			expect(second).not.toBe(first);
			expect(NodeResultCache.getInstance()).toBe(second);
		});

		it("should destroy the previous InMemoryCache provider", async () => {
			const oldProvider = new InMemoryCache({ maxSize: 10 });
			NodeResultCache.configure({ provider: oldProvider });
			await oldProvider.set("key", "value");

			const newProvider = new InMemoryCache({ maxSize: 20 });
			NodeResultCache.configure({ provider: newProvider });

			// Old provider was destroyed, its store should be empty
			const stats = oldProvider.getStats();
			expect(stats.size).toBe(0);
			newProvider.destroy();
		});
	});

	describe("resetInstance", () => {
		it("should create a fresh instance on next getInstance call", () => {
			const first = NodeResultCache.getInstance();
			NodeResultCache.resetInstance();
			const second = NodeResultCache.getInstance();
			expect(first).not.toBe(second);
		});

		it("should be safe to call when no instance exists", () => {
			NodeResultCache.resetInstance();
			NodeResultCache.resetInstance();
			// No error thrown
		});
	});

	// -- wrapExecution ------------------------------------------------------

	describe("wrapExecution", () => {
		it("should execute and return on cache miss", async () => {
			const instance = NodeResultCache.getInstance();
			const executeFn = vi.fn().mockResolvedValue({ result: 42 });

			const result = await instance.wrapExecution("myNode", { x: 1 }, executeFn);

			expect(result.cached).toBe(false);
			expect(result.data).toEqual({ result: 42 });
			expect(result.key).toBeDefined();
			expect(executeFn).toHaveBeenCalledTimes(1);
		});

		it("should return cached result on second call with same inputs", async () => {
			const instance = NodeResultCache.getInstance();
			const executeFn = vi.fn().mockResolvedValue({ result: 42 });

			await instance.wrapExecution("myNode", { x: 1 }, executeFn);
			const result = await instance.wrapExecution("myNode", { x: 1 }, executeFn);

			expect(result.cached).toBe(true);
			expect(result.data).toEqual({ result: 42 });
			expect(result.ttlRemainingMs).toBeDefined();
			expect(result.ttlRemainingMs!).toBeGreaterThan(0);
			expect(executeFn).toHaveBeenCalledTimes(1);
		});

		it("should produce different cache keys for different inputs", async () => {
			const instance = NodeResultCache.getInstance();
			const executeFn1 = vi.fn().mockResolvedValue("result-A");
			const executeFn2 = vi.fn().mockResolvedValue("result-B");

			const res1 = await instance.wrapExecution("myNode", { x: 1 }, executeFn1);
			const res2 = await instance.wrapExecution("myNode", { x: 2 }, executeFn2);

			expect(res1.key).not.toBe(res2.key);
			expect(res1.data).toBe("result-A");
			expect(res2.data).toBe("result-B");
			expect(executeFn1).toHaveBeenCalledTimes(1);
			expect(executeFn2).toHaveBeenCalledTimes(1);
		});

		it("should produce different cache keys for different node names", async () => {
			const instance = NodeResultCache.getInstance();
			const executeFn1 = vi.fn().mockResolvedValue("result-A");
			const executeFn2 = vi.fn().mockResolvedValue("result-B");

			const res1 = await instance.wrapExecution("nodeA", { x: 1 }, executeFn1);
			const res2 = await instance.wrapExecution("nodeB", { x: 1 }, executeFn2);

			expect(res1.key).not.toBe(res2.key);
			expect(executeFn1).toHaveBeenCalledTimes(1);
			expect(executeFn2).toHaveBeenCalledTimes(1);
		});

		it("should store entries with provided tags and ttl", async () => {
			const provider = new InMemoryCache({ maxSize: 100 });
			const instance = NodeResultCache.configure({ provider });

			const executeFn = vi.fn().mockResolvedValue("tagged-result");
			await instance.wrapExecution("myNode", { x: 1 }, executeFn, {
				tags: ["group-a"],
				ttlMs: 30_000,
			});

			// Invalidate by tag should clear it
			provider.invalidateByTag("group-a");
			const stats = provider.getStats();
			expect(stats.size).toBe(0);
		});

		it("should handle execution errors gracefully", async () => {
			const instance = NodeResultCache.getInstance();
			const executeFn = vi.fn().mockRejectedValue(new Error("execution failed"));

			await expect(instance.wrapExecution("myNode", { x: 1 }, executeFn)).rejects.toThrow("execution failed");
		});

		it("should clean up inflight map even when execution throws", async () => {
			const instance = NodeResultCache.getInstance();
			const executeFn = vi.fn().mockRejectedValue(new Error("fail"));

			try {
				await instance.wrapExecution("myNode", { x: 1 }, executeFn);
			} catch {
				// expected
			}

			// A second call should execute again (not hang on stale inflight entry)
			const executeFn2 = vi.fn().mockResolvedValue("recovered");
			const result = await instance.wrapExecution("myNode", { x: 1 }, executeFn2);
			expect(result.data).toBe("recovered");
			expect(executeFn2).toHaveBeenCalledTimes(1);
		});
	});

	// -- invalidateNode -----------------------------------------------------

	describe("invalidateNode", () => {
		it("should clear all entries for a specific node", async () => {
			const instance = NodeResultCache.getInstance();
			const fn = vi.fn().mockResolvedValue("value");

			await instance.wrapExecution("targetNode", { a: 1 }, fn);
			await instance.wrapExecution("targetNode", { a: 2 }, fn);
			await instance.wrapExecution("otherNode", { a: 1 }, fn);

			await instance.invalidateNode("targetNode");

			// targetNode entries should be invalidated
			const fn2 = vi.fn().mockResolvedValue("new-value");
			const res1 = await instance.wrapExecution("targetNode", { a: 1 }, fn2);
			expect(res1.cached).toBe(false);

			const res2 = await instance.wrapExecution("targetNode", { a: 2 }, fn2);
			expect(res2.cached).toBe(false);

			// otherNode entry should still be cached
			const fn3 = vi.fn().mockResolvedValue("should-not-call");
			const res3 = await instance.wrapExecution("otherNode", { a: 1 }, fn3);
			expect(res3.cached).toBe(true);
			expect(fn3).not.toHaveBeenCalled();
		});
	});

	// -- invalidateByTags ---------------------------------------------------

	describe("invalidateByTags", () => {
		it("should invalidate all entries with matching tags", async () => {
			const provider = new InMemoryCache({ maxSize: 100 });
			const instance = NodeResultCache.configure({ provider });

			const fn = vi.fn().mockResolvedValue("value");
			await instance.wrapExecution("node1", { x: 1 }, fn, { tags: ["auth"] });
			await instance.wrapExecution("node2", { x: 2 }, fn, { tags: ["auth", "user"] });
			await instance.wrapExecution("node3", { x: 3 }, fn, { tags: ["data"] });

			await instance.invalidateByTags(["auth"]);

			const fn2 = vi.fn().mockResolvedValue("new");
			const res1 = await instance.wrapExecution("node1", { x: 1 }, fn2);
			expect(res1.cached).toBe(false);

			const res2 = await instance.wrapExecution("node2", { x: 2 }, fn2);
			expect(res2.cached).toBe(false);

			const fn3 = vi.fn().mockResolvedValue("should-not-call");
			const res3 = await instance.wrapExecution("node3", { x: 3 }, fn3);
			expect(res3.cached).toBe(true);
			expect(fn3).not.toHaveBeenCalled();
		});

		it("should handle multiple tags to invalidate", async () => {
			const provider = new InMemoryCache({ maxSize: 100 });
			const instance = NodeResultCache.configure({ provider });

			const fn = vi.fn().mockResolvedValue("value");
			await instance.wrapExecution("node1", { x: 1 }, fn, { tags: ["auth"] });
			await instance.wrapExecution("node2", { x: 2 }, fn, { tags: ["data"] });

			await instance.invalidateByTags(["auth", "data"]);

			const fn2 = vi.fn().mockResolvedValue("new");
			const res1 = await instance.wrapExecution("node1", { x: 1 }, fn2);
			expect(res1.cached).toBe(false);
			const res2 = await instance.wrapExecution("node2", { x: 2 }, fn2);
			expect(res2.cached).toBe(false);
		});
	});

	// -- warmup -------------------------------------------------------------

	describe("warmup", () => {
		it("should pre-populate cache for given inputs", async () => {
			const instance = NodeResultCache.getInstance();
			const computeFn = vi.fn(async (input: number) => input * 10);

			await instance.warmup("calcNode", [1, 2, 3], computeFn);

			expect(computeFn).toHaveBeenCalledTimes(3);

			// Subsequent wrapExecution calls should be cache hits
			const executeFn = vi.fn().mockResolvedValue(-1);
			const res1 = await instance.wrapExecution("calcNode", 1, executeFn);
			expect(res1.cached).toBe(true);
			expect(res1.data).toBe(10);

			const res2 = await instance.wrapExecution("calcNode", 2, executeFn);
			expect(res2.cached).toBe(true);
			expect(res2.data).toBe(20);

			const res3 = await instance.wrapExecution("calcNode", 3, executeFn);
			expect(res3.cached).toBe(true);
			expect(res3.data).toBe(30);

			// executeFn should never have been called
			expect(executeFn).not.toHaveBeenCalled();
		});

		it("should not overwrite existing entries during warmup", async () => {
			const instance = NodeResultCache.getInstance();

			// Pre-populate via wrapExecution
			const originalFn = vi.fn().mockResolvedValue("original");
			await instance.wrapExecution("myNode", 1, originalFn);

			// warmup should skip existing
			const warmupFn = vi.fn(async () => "warmup-value");
			await instance.warmup("myNode", [1], warmupFn);

			expect(warmupFn).not.toHaveBeenCalled();

			// Original value should still be there
			const checkFn = vi.fn().mockResolvedValue("should-not-run");
			const result = await instance.wrapExecution("myNode", 1, checkFn);
			expect(result.cached).toBe(true);
			expect(result.data).toBe("original");
		});
	});

	// -- getStats -----------------------------------------------------------

	describe("getStats", () => {
		it("should return current statistics from the underlying provider", async () => {
			const instance = NodeResultCache.getInstance();
			const fn = vi.fn().mockResolvedValue("value");

			await instance.wrapExecution("node1", { x: 1 }, fn);
			await instance.wrapExecution("node1", { x: 1 }, fn); // hit

			const stats = instance.getStats();
			expect(stats.hits).toBeGreaterThanOrEqual(1);
			expect(stats.totalSets).toBeGreaterThanOrEqual(1);
			expect(stats.size).toBeGreaterThanOrEqual(1);
		});
	});

	// -- Disabled cache -----------------------------------------------------

	describe("disabled cache", () => {
		it("should always execute when cache is disabled", async () => {
			const provider = new InMemoryCache({ maxSize: 100 });
			const instance = NodeResultCache.configure({ enabled: false, provider });

			const executeFn = vi.fn().mockResolvedValue("result");

			const res1 = await instance.wrapExecution("myNode", { x: 1 }, executeFn);
			expect(res1.cached).toBe(false);
			expect(res1.data).toBe("result");

			const res2 = await instance.wrapExecution("myNode", { x: 1 }, executeFn);
			expect(res2.cached).toBe(false);
			expect(res2.data).toBe("result");

			// Execute called both times since cache is disabled
			expect(executeFn).toHaveBeenCalledTimes(2);
		});

		it("should not store entries when cache is disabled", async () => {
			const provider = new InMemoryCache({ maxSize: 100 });
			const instance = NodeResultCache.configure({ enabled: false, provider });

			const executeFn = vi.fn().mockResolvedValue("result");
			await instance.wrapExecution("myNode", { x: 1 }, executeFn);

			expect(provider.getStats().size).toBe(0);
			provider.destroy();
		});
	});

	// -- Key strategies -----------------------------------------------------

	describe("key strategies", () => {
		describe("input-hash strategy", () => {
			it("should generate key based solely on input hash", async () => {
				const provider = new InMemoryCache({ maxSize: 100 });
				const instance = NodeResultCache.configure({
					provider,
					keyStrategy: "input-hash",
				});

				const fn = vi.fn().mockResolvedValue("value");
				const res = await instance.wrapExecution("anyNode", { x: 1 }, fn);

				// input-hash keys are SHA-256 hex digests (64 chars)
				expect(res.key).toMatch(/^[a-f0-9]{64}$/);
			});

			it("should produce the same key for same input regardless of node name", async () => {
				const provider = new InMemoryCache({ maxSize: 100 });
				const instance = NodeResultCache.configure({
					provider,
					keyStrategy: "input-hash",
				});

				const fn1 = vi.fn().mockResolvedValue("value1");
				const fn2 = vi.fn().mockResolvedValue("value2");
				const res1 = await instance.wrapExecution("nodeA", { x: 1 }, fn1);
				const res2 = await instance.wrapExecution("nodeB", { x: 1 }, fn2);

				// Same input -> same key (node name is ignored)
				expect(res1.key).toBe(res2.key);
				// Second call is a cache hit
				expect(res2.cached).toBe(true);
			});
		});

		describe("node-input strategy (default)", () => {
			it("should generate key including node name prefix", async () => {
				const instance = NodeResultCache.getInstance();
				const fn = vi.fn().mockResolvedValue("value");
				const res = await instance.wrapExecution("myNode", { x: 1 }, fn);

				expect(res.key).toMatch(/^node:myNode:/);
			});

			it("should produce different keys for different node names with same input", async () => {
				const instance = NodeResultCache.getInstance();
				const fn = vi.fn().mockResolvedValue("value");
				const res1 = await instance.wrapExecution("nodeA", { x: 1 }, fn);
				const res2 = await instance.wrapExecution("nodeB", { x: 1 }, fn);

				expect(res1.key).not.toBe(res2.key);
			});
		});

		describe("custom strategy", () => {
			it("should use the provided custom key function", async () => {
				const provider = new InMemoryCache({ maxSize: 100 });
				const customKeyFn = (nodeName: string, input: unknown) => `custom:${nodeName}:${JSON.stringify(input)}`;

				const instance = NodeResultCache.configure({
					provider,
					keyStrategy: "custom",
					customKeyFn,
				});

				const fn = vi.fn().mockResolvedValue("value");
				const res = await instance.wrapExecution("myNode", { x: 1 }, fn);

				expect(res.key).toBe('custom:myNode:{"x":1}');
			});

			it("should throw when custom strategy is used without customKeyFn", () => {
				expect(() => {
					NodeResultCache.configure({ keyStrategy: "custom" });
				}).toThrow('NodeResultCache: "custom" key strategy requires a customKeyFn to be provided.');
			});
		});
	});

	// -- getProvider --------------------------------------------------------

	describe("getProvider", () => {
		it("should return the underlying cache provider", () => {
			const provider = new InMemoryCache({ maxSize: 50 });
			const instance = NodeResultCache.configure({ provider });
			expect(instance.getProvider()).toBe(provider);
		});

		it("should return an InMemoryCache by default", () => {
			const instance = NodeResultCache.getInstance();
			expect(instance.getProvider()).toBeInstanceOf(InMemoryCache);
		});
	});

	// -- Request coalescing (thundering herd) --------------------------------

	describe("request coalescing", () => {
		it("should deduplicate concurrent executions for the same key", async () => {
			const instance = NodeResultCache.getInstance();
			let callCount = 0;
			const slowExecute = () =>
				new Promise<string>((resolve) => {
					callCount++;
					setTimeout(() => resolve("result"), 50);
				});

			// Fire two concurrent calls with the same input
			const [res1, res2] = await Promise.all([
				instance.wrapExecution("myNode", { x: 1 }, slowExecute),
				instance.wrapExecution("myNode", { x: 1 }, slowExecute),
			]);

			// Only one execution should have happened
			expect(callCount).toBe(1);
			expect(res1.data).toBe("result");
			expect(res2.data).toBe("result");
		});
	});
});
