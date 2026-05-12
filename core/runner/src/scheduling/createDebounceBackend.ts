/**
 * Tier C #1 · Debounce backend factory.
 *
 * Reads `BLOK_DEBOUNCE_BACKEND` and returns the matching backend
 * instance, or `null` when the operator wants the default in-process
 * coordinator (no cross-process coordination).
 *
 * Trigger packages call this in `listen()` and pass the result to
 * `DebounceCoordinator.getInstance().setBackend(backend)`.
 */

import type { DebounceBackend } from "./DebounceBackend";
import { NatsKvDebounceBackend } from "./NatsKvDebounceBackend";
import { RedisDebounceBackend } from "./RedisDebounceBackend";

/**
 * Returns a configured `DebounceBackend` based on
 * `BLOK_DEBOUNCE_BACKEND`, or `null` for the default in-memory coordinator.
 *
 * Recognized values:
 * - unset / `""` / `"memory"` / `"in-process"` — null (use default in-memory)
 * - `"nats-kv"` — NATS KV backend (requires `nats` package + reachable NATS server)
 * - `"redis"` — Redis backend (requires `ioredis` package + reachable Redis server)
 *
 * Unknown values throw at startup with a clear error message — silently
 * falling back would be dangerous (operator thinks they configured
 * cross-process debounce but they didn't).
 */
export function createDebounceBackend(): DebounceBackend | null {
	const kind = (process.env.BLOK_DEBOUNCE_BACKEND ?? "").trim().toLowerCase();
	if (!kind || kind === "memory" || kind === "in-process") return null;

	switch (kind) {
		case "nats-kv":
			return new NatsKvDebounceBackend();
		case "redis":
			return new RedisDebounceBackend();
		default:
			throw new Error(
				`Unknown BLOK_DEBOUNCE_BACKEND='${kind}'. Expected one of: 'memory' (default), 'nats-kv', 'redis'.`,
			);
	}
}
