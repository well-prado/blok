<?php

declare(strict_types=1);

namespace Blok\Blok\Errors;

/**
 * Bounded slice of inputs + recent vars for the
 * `BlokError->contextSnapshot` field, per master plan §17.6.
 *
 * Default budget: 4 KB serialized + last-16 vars keys, with progressive
 * trimming when oversize. `inputs` is preserved as-is — it's the most
 * LLM-actionable context. Mirrors Python's `build_context_snapshot`, Go's
 * `BuildContextSnapshot`, Rust's `build_context_snapshot`, Java's
 * `BuildContextSnapshot.of`, C#'s `BuildContextSnapshot.Of`, and Ruby's
 * `BuildContextSnapshot.of`.
 */
final class BuildContextSnapshot
{
    /**
     * Snapshot of `inputs` + last-16 vars keys, capped at 4 KB.
     *
     * @param array<string, mixed> $inputs
     * @param array<string, mixed> $vars
     * @return array<string, mixed>
     */
    public static function of(array $inputs, array $vars): array
    {
        return self::withOpts($inputs, $vars, BlokError::CONTEXT_SNAPSHOT_MAX_BYTES, 16);
    }

    /**
     * Customizable variant. `$maxVarsKeys = 0` drops vars entirely.
     * `$maxBytes <= 0` disables byte-budget trimming.
     *
     * @param array<string, mixed> $inputs
     * @param array<string, mixed> $vars
     * @return array<string, mixed>
     */
    public static function withOpts(array $inputs, array $vars, int $maxBytes, int $maxVarsKeys): array
    {
        $safeInputs = self::jsonSafeMap($inputs);

        // ksort gives a deterministic "last N" slice. PHP arrays preserve
        // insertion order, but tests need cross-runtime determinism;
        // mirroring Java's TreeMap, Rust's BTreeMap, C#'s SortedDictionary,
        // and Ruby's sorted-keys.
        ksort($vars);
        $keys = array_keys($vars);
        if ($maxVarsKeys >= 0 && count($keys) > $maxVarsKeys) {
            $keys = array_slice($keys, count($keys) - $maxVarsKeys);
        }

        $snapshot = [
            'inputs' => $safeInputs,
            'vars'   => self::buildRecent($vars, $keys),
        ];

        if ($maxBytes <= 0) {
            return $snapshot;
        }

        if (self::encodedBytes($snapshot) <= $maxBytes) {
            return $snapshot;
        }

        // Trim from the front (oldest keys) until the snapshot fits.
        while (!empty($keys)) {
            array_shift($keys);
            $snapshot['vars'] = self::buildRecent($vars, $keys);
            if (self::encodedBytes($snapshot) <= $maxBytes) {
                return $snapshot;
            }
        }

        return [
            'inputs'      => $safeInputs,
            'vars'        => [],
            '_truncated'  => true,
        ];
    }

    /**
     * @param array<string, mixed> $vars
     * @param array<int, string>   $keys
     * @return array<string, mixed>
     */
    private static function buildRecent(array $vars, array $keys): array
    {
        $recent = [];
        foreach ($keys as $k) {
            if (array_key_exists($k, $vars)) {
                $recent[$k] = self::jsonSafe($vars[$k]);
            }
        }
        return $recent;
    }

    private static function encodedBytes(mixed $value): int
    {
        $json = json_encode($value, JSON_UNESCAPED_SLASHES);
        if ($json === false) {
            return PHP_INT_MAX;
        }
        return strlen($json);
    }

    /**
     * @param array<string, mixed> $m
     * @return array<string, mixed>
     */
    private static function jsonSafeMap(array $m): array
    {
        $out = [];
        foreach ($m as $k => $v) {
            $out[(string) $k] = self::jsonSafe($v);
        }
        return $out;
    }

    private static function jsonSafe(mixed $v): mixed
    {
        if (is_scalar($v) || $v === null) {
            return $v;
        }
        if (is_array($v)) {
            // Arrays may be associative or list — preserve as-is.
            $out = [];
            foreach ($v as $k => $val) {
                $out[is_int($k) ? $k : (string) $k] = self::jsonSafe($val);
            }
            return $out;
        }
        // Try JSON round-trip; fall back to a string repr.
        $json = json_encode($v, JSON_UNESCAPED_SLASHES);
        if ($json !== false) {
            return json_decode($json, true);
        }
        return is_object($v) ? $v::class : 'unserializable';
    }
}
