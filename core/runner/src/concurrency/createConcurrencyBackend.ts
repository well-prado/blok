/**
 * Tier 2 #6 follow-up · concurrency backend factory.
 *
 * Reads `BLOK_CONCURRENCY_BACKEND` and returns the matching backend
 * instance, or `null` when the user wants the default in-process behavior.
 *
 * Trigger packages call this in `listen()` and pass the result to
 * `RunTracker.getInstance().setConcurrencyBackend(backend)`.
 */

import type { ConcurrencyBackend } from "./ConcurrencyBackend";
import { NatsKvConcurrencyBackend } from "./NatsKvConcurrencyBackend";
import { RedisConcurrencyBackend } from "./RedisConcurrencyBackend";

/**
 * Returns a configured `ConcurrencyBackend` based on
 * `BLOK_CONCURRENCY_BACKEND`, or `null` for the default in-process backend.
 *
 * Recognized values:
 * - unset / `""` / `"memory"` — null (use default in-process via RunStore)
 * - `"nats-kv"` — NATS KV backend (requires `nats` package + reachable NATS server)
 * - `"redis"` — Redis backend (requires `ioredis` package + reachable Redis server)
 *
 * Unknown values throw at startup with a clear error message — silently
 * falling back would be dangerous (operator thinks they configured cross-
 * process coordination but they didn't).
 */
export function createConcurrencyBackend(): ConcurrencyBackend | null {
	const kind = (process.env.BLOK_CONCURRENCY_BACKEND ?? "").trim().toLowerCase();
	if (!kind || kind === "memory" || kind === "in-process") return null;

	switch (kind) {
		case "nats-kv":
			return new NatsKvConcurrencyBackend();
		case "redis":
			return new RedisConcurrencyBackend();
		default:
			throw new Error(
				`Unknown BLOK_CONCURRENCY_BACKEND='${kind}'. Expected one of: 'memory' (default), 'nats-kv', 'redis'.`,
			);
	}
}
