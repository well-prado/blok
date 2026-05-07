/**
 * Tier 2 #5 + #7 — extract scheduling config from a workflow's trigger
 * block, regardless of which trigger type owns it (HTTP, Worker, …).
 *
 * Returns `null` when the trigger has NO scheduling fields set. The
 * caller (`TriggerBase.run()`) treats null as "skip the gates, run the
 * workflow synchronously" — zero-overhead default.
 *
 * Upfront duration parsing converts `"1h"` → `3600000` so downstream
 * code only deals in milliseconds. Invalid duration values are dropped
 * (treated as if the field were unset) — this is fail-open by design,
 * matching `idempotencyKey` semantics. Use `BLOK_MAPPER_MODE=strict`
 * for fail-fast behavior in production (handled at the trigger config
 * validation layer, not here).
 */
import { tryParseDuration } from "@blokjs/helper";

const SCHEDULING_TRIGGER_KEYS = ["http", "worker"] as const;

/** Parsed, normalized debounce config ready for the coordinator. */
export interface NormalizedDebounceConfig {
	keyExpression: string;
	mode: "leading" | "trailing";
	delayMs: number;
	maxDelayMs?: number;
}

/** Parsed, normalized scheduling config ready for the gates. */
export interface NormalizedSchedulingConfig {
	/** Delay in ms; undefined when no delay configured. */
	delayMs?: number;
	/** TTL in ms; undefined when no TTL configured. */
	ttlMs?: number;
	/** Debounce config; undefined when no debounce configured. */
	debounce?: NormalizedDebounceConfig;
}

interface RawDebounce {
	key?: unknown;
	mode?: unknown;
	delay?: unknown;
	maxDelay?: unknown;
}

interface RawScheduling {
	delay?: unknown;
	ttl?: unknown;
	debounce?: RawDebounce;
}

/**
 * Read a workflow's trigger config and return the normalized scheduling
 * config, or null when the workflow has no scheduling gates.
 */
export function readSchedulingConfig(
	trigger: Record<string, unknown> | undefined | null,
): NormalizedSchedulingConfig | null {
	if (!trigger) return null;

	for (const triggerKey of SCHEDULING_TRIGGER_KEYS) {
		const cfg = trigger[triggerKey] as RawScheduling | undefined;
		if (!cfg) continue;

		const delayMs = cfg.delay !== undefined ? (tryParseDuration(cfg.delay) ?? undefined) : undefined;
		const ttlMs = cfg.ttl !== undefined ? (tryParseDuration(cfg.ttl) ?? undefined) : undefined;

		let debounce: NormalizedDebounceConfig | undefined;
		if (cfg.debounce && typeof cfg.debounce === "object") {
			const d = cfg.debounce;
			const keyExpression = typeof d.key === "string" ? d.key.trim() : "";
			const dDelayMs = d.delay !== undefined ? (tryParseDuration(d.delay) ?? undefined) : undefined;
			if (keyExpression && dDelayMs !== undefined && dDelayMs >= 0) {
				const mode: "leading" | "trailing" = d.mode === "leading" ? "leading" : "trailing";
				const maxDelayMs = d.maxDelay !== undefined ? (tryParseDuration(d.maxDelay) ?? undefined) : undefined;
				debounce = { keyExpression, mode, delayMs: dDelayMs, maxDelayMs };
			}
		}

		const hasAny = delayMs !== undefined || ttlMs !== undefined || debounce !== undefined;
		if (hasAny) {
			return { delayMs, ttlMs, debounce };
		}
	}

	return null;
}

export const SCHEDULING_DEFAULTS = {
	debounceMode: "trailing" as const,
} as const;
