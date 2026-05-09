import { defineNode } from "@blokjs/runner";
import type { Redis as IoRedis } from "ioredis";
import { z } from "zod";

/**
 * Redis-backed key-value helper. Production drop-in for `@blokjs/in-memory-kv`
 * — same `set` / `get` / `delete` / `list` actions, same JSON-encoded value
 * shape, same per-key TTL semantics. The difference is durability: counters
 * survive process restarts, multiple replicas share state, and bucket data
 * is visible across the cluster.
 *
 * Use this in a rate-limit middleware that needs to enforce limits across
 * a fleet (the in-memory variant is per-process and resets on restart).
 *
 * Connection model: ONE shared `ioredis` client per process, lazy-created
 * on first invocation, keyed off `REDIS_URL` from env (default
 * `redis://127.0.0.1:6379`). All requests serve through the same client
 * — ioredis handles command queueing internally. The client lives until
 * the process exits; explicit teardown via `_teardownRedisForTests` is
 * test-only.
 *
 * The dependency on `ioredis` is loaded dynamically so this file can ship
 * in environments that don't actually use Redis (e.g. dev workflows that
 * still register `HELPER_NODES` for completeness). The first call to
 * `getRedis()` is the only thing that needs the package present.
 */

let _redisClient: IoRedis | null = null;

async function getRedis(): Promise<IoRedis> {
	if (_redisClient !== null) return _redisClient;
	type RedisCtor = new (url: string) => IoRedis;
	type IoRedisModule = { default?: RedisCtor; Redis?: RedisCtor };
	let mod: IoRedisModule;
	try {
		mod = (await import("ioredis")) as IoRedisModule;
	} catch (err) {
		throw new Error(
			`@blokjs/redis-kv: failed to load 'ioredis' — install it as a dependency of your project, or remove the redis-kv node from your workflow. Underlying: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const Ctor = mod.default ?? mod.Redis;
	if (typeof Ctor !== "function") {
		throw new Error("@blokjs/redis-kv: 'ioredis' module did not expose a Redis constructor.");
	}
	const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
	_redisClient = new Ctor(url);
	return _redisClient;
}

/**
 * Test-only — closes the shared ioredis client and resets the cache so
 * the next `getRedis()` call lazy-creates a fresh one. Public so test
 * suites can isolate runs; do NOT call from production code.
 */
export async function _teardownRedisForTests(): Promise<void> {
	if (_redisClient !== null) {
		try {
			await _redisClient.quit();
		} catch {
			// best-effort
		}
		_redisClient = null;
	}
}

const inputSchema = z.object({
	action: z
		.enum(["get", "set", "delete", "list"])
		.describe("Operation to perform: get | set | delete | list (with optional prefix filter)."),
	key: z.string().optional().describe("Key to operate on. Required for `get` / `set` / `delete`. Ignored for `list`."),
	value: z
		.unknown()
		.optional()
		.describe("Value to write. JSON-encoded internally so any JSON-serializable value works. Required for `set`."),
	ttlMs: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe(
			"Optional per-key TTL in milliseconds. When set, ioredis writes via SET ... PX <ttlMs>; Redis evicts " +
				"automatically when the TTL elapses — no background reaper needed. Without ttlMs, the key persists " +
				"until explicitly deleted (or the bucket evicts under memory pressure).",
		),
	prefix: z
		.string()
		.optional()
		.describe(
			"For `list` only — restrict results to keys starting with this prefix. Implementation uses Redis SCAN " +
				"with a MATCH pattern (`<prefix>*`), so it's safe on production-scale keyspaces. Without prefix, " +
				"`list` returns ALL keys in the database — usually undesirable; pass a prefix.",
		),
});

const outputSchema = z.object({
	action: z.enum(["get", "set", "delete", "list"]),
	key: z.string().optional(),
	value: z.unknown().optional(),
	exists: z.boolean().optional(),
	deleted: z.boolean().optional(),
	entries: z.array(z.object({ key: z.string(), value: z.unknown() })).optional(),
});

export default defineNode({
	name: "@blokjs/redis-kv",
	description:
		"Redis-backed key-value helper. Drop-in replacement for @blokjs/in-memory-kv — survives restarts and works across replicas. Connects via REDIS_URL env (default redis://127.0.0.1:6379).",
	input: inputSchema,
	output: outputSchema,

	async execute(_ctx, input) {
		const redis = await getRedis();

		switch (input.action) {
			case "get": {
				if (input.key === undefined) {
					throw new Error("@blokjs/redis-kv: action=get requires `key`.");
				}
				const raw = await redis.get(input.key);
				if (raw === null) {
					return { action: "get" as const, key: input.key, exists: false };
				}
				return {
					action: "get" as const,
					key: input.key,
					value: safeParse(raw),
					exists: true,
				};
			}
			case "set": {
				if (input.key === undefined) {
					throw new Error("@blokjs/redis-kv: action=set requires `key`.");
				}
				if (input.value === undefined) {
					throw new Error("@blokjs/redis-kv: action=set requires `value`.");
				}
				const encoded = JSON.stringify(input.value);
				if (input.ttlMs !== undefined) {
					await redis.set(input.key, encoded, "PX", input.ttlMs);
				} else {
					await redis.set(input.key, encoded);
				}
				return { action: "set" as const, key: input.key, value: input.value };
			}
			case "delete": {
				if (input.key === undefined) {
					throw new Error("@blokjs/redis-kv: action=delete requires `key`.");
				}
				const removed = await redis.del(input.key);
				return { action: "delete" as const, key: input.key, deleted: removed > 0 };
			}
			case "list": {
				const pattern = input.prefix !== undefined ? `${input.prefix}*` : "*";
				// SCAN over MATCH avoids the multi-second blocking that KEYS
				// produces on large databases. Cursor-based — drains every
				// matching key but yields control between batches.
				const keys: string[] = [];
				let cursor = "0";
				do {
					const reply = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
					cursor = reply[0];
					for (const k of reply[1]) keys.push(k);
				} while (cursor !== "0");

				if (keys.length === 0) {
					return { action: "list" as const, entries: [] };
				}
				const values = await redis.mget(...keys);
				const entries: { key: string; value: unknown }[] = [];
				for (let i = 0; i < keys.length; i++) {
					const v = values[i];
					if (v !== null) {
						entries.push({ key: keys[i], value: safeParse(v) });
					}
				}
				return { action: "list" as const, entries };
			}
		}
	},
});

/**
 * Tolerate raw strings written by other clients (where the value isn't a
 * JSON-encoded payload). Returning the string verbatim is the
 * least-surprising fallback — better than throwing on a value the helper
 * itself didn't write.
 */
function safeParse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}
