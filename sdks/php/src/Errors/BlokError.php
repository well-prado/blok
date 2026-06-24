<?php

declare(strict_types=1);

namespace Blok\Blok\Errors;

use ReflectionClass;
use SplObjectStorage;
use Throwable;

/**
 * Structured `BlokError` per master plan §17 — the canonical error contract
 * every Blok node SDK populates the same way.
 *
 * Mirrors the TypeScript `BlokError`, Python `BlokError`, Go `*BlokError`,
 * Rust `BlokError`, Java `BlokError`, C# `BlokError`, and Ruby `BlokError`,
 * so node authors writing in any language see the same field shape.
 *
 * Idiomatic usage (master plan §17.5 fluent builder):
 *
 * ```php
 * throw BlokError::dependency()
 *     ->code('POSTGRES_CONNECT_TIMEOUT')
 *     ->message('Could not connect to Postgres within 5s')
 *     ->description("Tried host={$host} port={$port}; timeout={$dur}")
 *     ->remediation('Check DATABASE_URL env var and network reachability')
 *     ->cause($e)
 *     ->retryable(true)
 *     ->retryAfterMs(5000)
 *     ->details(['host' => $host, 'port' => $port])
 *     ->build();
 * ```
 *
 * Extends {@see \Exception} so handlers can `throw` it directly. The legacy
 * {@see NodeException} (5 categories) stays available for back-compat. New
 * code should prefer `BlokError`.
 */
final class BlokError extends \Exception
{
    // Untyped consts: typed class constants are PHP 8.3+, but composer declares
    // `php: >=8.2`. Under 8.2 `const string NAME` is a parse error, which only
    // surfaced on the error path (BlokError autoloads lazily) as a gRPC SoftJob.
    public const DEFAULT_SDK_NAME = 'blok-php';
    public const DEFAULT_RUNTIME_KIND = 'runtime.php';
    public const CONTEXT_SNAPSHOT_MAX_BYTES = 4096;

    public BlokErrorCategory $category;
    public BlokErrorSeverity $severity;
    public string $errorCode;
    public string $description;
    public string $remediation;
    public string $docUrl;
    public int $httpStatus;
    public bool $retryable;
    public int $retryAfterMs;
    public mixed $details;
    public mixed $contextSnapshot;
    /** @var array<int, array<string, mixed>> */
    public array $causes;
    public string $stack;
    public \DateTimeImmutable $at;
    public string $node;
    public string $sdk;
    public string $sdkVersion;
    public string $runtimeKind;

    /**
     * Direct constructor. Prefer the static factories
     * ({@see self::dependency()}, {@see self::validation()}, etc.) which
     * pre-populate per-category defaults.
     *
     * @param array<int, array<string, mixed>> $causes
     */
    public function __construct(
        BlokErrorCategory $category,
        string $code,
        string $message,
        string $description = '',
        string $remediation = '',
        string $docUrl = '',
        ?Throwable $cause = null,
        ?bool $retryable = null,
        int $retryAfterMs = 0,
        mixed $details = null,
        mixed $contextSnapshot = null,
        ?int $httpStatus = null,
        BlokErrorSeverity $severity = BlokErrorSeverity::Error,
        string $node = '',
        string $sdk = '',
        string $sdkVersion = '',
        string $runtimeKind = '',
        ?\DateTimeImmutable $at = null,
        ?string $stack = null,
        array $causes = [],
    ) {
        parent::__construct($message, 0, $cause);
        $this->category = $category;
        $this->severity = $severity;
        $this->errorCode = $code;
        $this->description = $description;
        $this->remediation = $remediation;
        $this->docUrl = $docUrl;
        $this->httpStatus = $httpStatus ?? $category->defaultHttpStatus();
        $this->retryable = $retryable ?? $category->defaultRetryable();
        $this->retryAfterMs = $retryAfterMs;
        $this->details = $details;
        $this->contextSnapshot = $contextSnapshot;
        $this->node = $node;
        $this->sdk = $sdk;
        $this->sdkVersion = $sdkVersion;
        $this->runtimeKind = $runtimeKind;
        $this->at = $at ?? new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        $this->stack = $stack ?? $this->getTraceAsString();
        // Causes provided explicitly (e.g. via from_hash) take priority; else
        // walk the cause chain at construction time.
        if (!empty($causes)) {
            $this->causes = $causes;
        } elseif ($cause !== null) {
            $this->causes = self::flattenCauses($cause);
        } else {
            $this->causes = [];
        }
    }

    public function __toString(): string
    {
        return sprintf('[%s] %s', $this->category->value, $this->getMessage());
    }

    // ===== Per-category factory shortcuts ===================================

    /** Builder for a `VALIDATION` error (default 400, non-retryable). */
    public static function validation(): BlokErrorBuilder { return new BlokErrorBuilder(BlokErrorCategory::Validation); }
    /** Builder for a `CONFIGURATION` error (default 500, non-retryable). */
    public static function configuration(): BlokErrorBuilder { return new BlokErrorBuilder(BlokErrorCategory::Configuration); }
    /** Builder for a `DEPENDENCY` error (default 502, retryable). */
    public static function dependency(): BlokErrorBuilder { return new BlokErrorBuilder(BlokErrorCategory::Dependency); }
    /** Builder for a `TIMEOUT` error (default 504, retryable). */
    public static function timeout(): BlokErrorBuilder { return new BlokErrorBuilder(BlokErrorCategory::Timeout); }
    /** Builder for a `PERMISSION` error (default 403, non-retryable). */
    public static function permission(): BlokErrorBuilder { return new BlokErrorBuilder(BlokErrorCategory::Permission); }
    /** Builder for a `RATE_LIMIT` error (default 429, retryable). */
    public static function rateLimit(): BlokErrorBuilder { return new BlokErrorBuilder(BlokErrorCategory::RateLimit); }
    /** Builder for a `NOT_FOUND` error (default 404, non-retryable). */
    public static function notFound(): BlokErrorBuilder { return new BlokErrorBuilder(BlokErrorCategory::NotFound); }
    /** Builder for a `CONFLICT` error (default 409, non-retryable). */
    public static function conflict(): BlokErrorBuilder { return new BlokErrorBuilder(BlokErrorCategory::Conflict); }
    /** Builder for a `CANCELLED` error (default 499, non-retryable). */
    public static function cancelled(): BlokErrorBuilder { return new BlokErrorBuilder(BlokErrorCategory::Cancelled); }
    /** Builder for an `INTERNAL` error (default 500, non-retryable). */
    public static function internal(): BlokErrorBuilder { return new BlokErrorBuilder(BlokErrorCategory::Internal); }
    /** Builder for a `PROTOCOL` error (default 502, non-retryable). */
    public static function protocol(): BlokErrorBuilder { return new BlokErrorBuilder(BlokErrorCategory::Protocol); }
    /** Builder for a `DATA` error (default 422, non-retryable). */
    public static function data(): BlokErrorBuilder { return new BlokErrorBuilder(BlokErrorCategory::Data); }

    /** Generic factory if the category isn't known at compile time. */
    public static function of(BlokErrorCategory $category): BlokErrorBuilder
    {
        return new BlokErrorBuilder($category);
    }

    // ===== Origin auto-enrichment ===========================================

    /**
     * Fill in any missing origin fields. Won't overwrite explicit values.
     */
    public function applyOriginIfMissing(Origin $origin): self
    {
        if ($this->node === '') $this->node = $origin->node;
        if ($this->sdk === '') $this->sdk = $origin->sdk;
        if ($this->sdkVersion === '') $this->sdkVersion = $origin->sdkVersion;
        if ($this->runtimeKind === '') $this->runtimeKind = $origin->runtimeKind;
        return $this;
    }

    // ===== Conversion =======================================================

    /**
     * Wrap any value as a `BlokError`. Used by the runner's auto-wrap layer
     * so legacy `throw new \RuntimeException(...)` still produces a structured
     * error.
     *
     * Categorization heuristic:
     * - {@see BlokError} — passthrough; missing origin fields filled in.
     * - {@see NodeException} (legacy) — preserves message/details/cause; INTERNAL.
     * - {@see Throwable} — wraps as INTERNAL with `code=UNCAUGHT_<TYPE>`.
     * - `array` — extracts `'message'` key, full payload preserved in details.
     * - `string` — becomes the message.
     * - `null` — placeholder `"node error"`.
     * - everything else — stringified, payload preserved in details.
     */
    public static function fromUnknown(mixed $value, Origin $origin): self
    {
        if ($value instanceof self) {
            $value->applyOriginIfMissing($origin);
            return $value;
        }
        if ($value instanceof NodeException) {
            return self::internal()
                ->code('UNCAUGHT_NODEEXCEPTION')
                ->message($value->getMessage())
                ->cause($value)
                ->details($value->toArray())
                ->applyOrigin($origin)
                ->build();
        }
        if ($value instanceof Throwable) {
            $msg = $value->getMessage();
            if ($msg === '') {
                $msg = 'Uncaught error';
            }
            return self::internal()
                ->code(self::uncaughtCode(get_class($value)))
                ->message($msg)
                ->cause($value)
                ->applyOrigin($origin)
                ->build();
        }
        if ($value === null) {
            return self::internal()
                ->code('UNCAUGHT_ERROR')
                ->message('node error')
                ->applyOrigin($origin)
                ->build();
        }
        if (is_string($value)) {
            return self::internal()
                ->code('UNCAUGHT_ERROR')
                ->message($value)
                ->details(['message' => $value])
                ->applyOrigin($origin)
                ->build();
        }
        if (is_array($value)) {
            $msg = $value['message'] ?? null;
            $message = (is_string($msg) && $msg !== '') ? $msg : 'node error';
            return self::internal()
                ->code('UNCAUGHT_ERROR')
                ->message($message)
                ->details($value)
                ->applyOrigin($origin)
                ->build();
        }
        $repr = is_scalar($value) ? (string) $value : (json_encode($value, JSON_UNESCAPED_SLASHES) ?: 'node error');
        return self::internal()
            ->code('UNCAUGHT_ERROR')
            ->message($repr)
            ->details(['message' => $repr])
            ->applyOrigin($origin)
            ->build();
    }

    /**
     * Lossless serialization to an associative array matching the proto wire
     * shape (snake_case keys). Inverse of {@see self::fromArray()}.
     *
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        return [
            'code'             => $this->errorCode,
            'category'         => $this->category->value,
            'severity'         => $this->severity->value,
            'node'             => $this->node,
            'sdk'              => $this->sdk,
            'sdk_version'      => $this->sdkVersion,
            'runtime_kind'     => $this->runtimeKind,
            'at'               => $this->at->format(\DateTimeInterface::RFC3339_EXTENDED),
            'message'          => $this->getMessage(),
            'description'      => $this->description,
            'remediation'      => $this->remediation,
            'doc_url'          => $this->docUrl,
            'causes'           => array_map(static fn (array $c) => $c, $this->causes),
            'stack'            => $this->stack,
            'context_snapshot' => $this->contextSnapshot,
            'http_status'      => $this->httpStatus,
            'retryable'        => $this->retryable,
            'retry_after_ms'   => $this->retryAfterMs,
            'details'          => $this->details,
        ];
    }

    /**
     * Reconstruct a `BlokError` from an associative array. Tolerates both
     * snake_case (PHP/Python/Go convention) and camelCase (TS payload shape)
     * keys for cross-language fixture compatibility.
     *
     * @param array<string, mixed> $raw
     */
    public static function fromArray(array $raw): self
    {
        $category = BlokErrorCategory::parse(self::pick($raw, ['category']));
        $severity = BlokErrorSeverity::parse(self::pick($raw, ['severity']));

        $causes = $raw['causes'] ?? [];
        if (!is_array($causes)) {
            $causes = [];
        }
        $typedCauses = [];
        foreach ($causes as $c) {
            if (is_array($c)) {
                $typedCauses[] = $c;
            }
        }

        $atRaw = self::pick($raw, ['at']);
        $at = is_string($atRaw) && $atRaw !== '' ? self::parseAt($atRaw) : null;

        return new self(
            category: $category,
            code: (string) (self::pick($raw, ['code']) ?? ''),
            message: (string) (self::pick($raw, ['message']) ?? ''),
            description: (string) (self::pick($raw, ['description']) ?? ''),
            remediation: (string) (self::pick($raw, ['remediation']) ?? ''),
            docUrl: (string) (self::pick($raw, ['doc_url', 'docUrl']) ?? ''),
            cause: null,
            retryable: self::pickBool($raw, ['retryable']),
            retryAfterMs: (int) (self::pick($raw, ['retry_after_ms', 'retryAfterMs']) ?? 0),
            details: $raw['details'] ?? null,
            contextSnapshot: self::pick($raw, ['context_snapshot', 'contextSnapshot']),
            httpStatus: self::pickInt($raw, ['http_status', 'httpStatus']),
            severity: $severity,
            node: (string) (self::pick($raw, ['node']) ?? ''),
            sdk: (string) (self::pick($raw, ['sdk']) ?? ''),
            sdkVersion: (string) (self::pick($raw, ['sdk_version', 'sdkVersion']) ?? ''),
            runtimeKind: (string) (self::pick($raw, ['runtime_kind', 'runtimeKind']) ?? ''),
            at: $at,
            stack: (string) (self::pick($raw, ['stack']) ?? ''),
            causes: $typedCauses,
        );
    }

    // ===== Cause-chain flattening ==========================================

    /**
     * Walk a Throwable's `getPrevious()` chain and produce a flat list of
     * payloads. Cycle-safe via {@see SplObjectStorage}; lifts a
     * {@see BlokError} link in directly so cross-wire serialization doesn't
     * double-count nested chains.
     *
     * @return array<int, array<string, mixed>>
     */
    public static function flattenCauses(Throwable $cause): array
    {
        $causes = [];
        $visited = new SplObjectStorage();
        $current = $cause;
        $depth = 0;
        while ($current !== null && $depth < 32) {
            if ($visited->contains($current)) {
                break;
            }
            $visited->attach($current);
            $depth++;
            if ($current instanceof self) {
                $payload = $current->toArray();
                $payload['causes'] = [];
                $causes[] = $payload;
                foreach ($current->causes as $nested) {
                    $causes[] = $nested;
                }
                return $causes;
            }
            $causes[] = self::throwableToPayload($current);
            $current = $current->getPrevious();
        }
        return $causes;
    }

    /**
     * @return array<string, mixed>
     */
    private static function throwableToPayload(Throwable $t): array
    {
        $message = $t->getMessage();
        return [
            'code'             => self::uncaughtCode(get_class($t)),
            'category'         => BlokErrorCategory::Internal->value,
            'severity'         => BlokErrorSeverity::Error->value,
            'node'             => '',
            'sdk'              => '',
            'sdk_version'      => '',
            'runtime_kind'     => '',
            'at'               => (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))
                                    ->format(\DateTimeInterface::RFC3339_EXTENDED),
            'message'          => $message === '' ? 'Uncaught error' : $message,
            'description'      => '',
            'remediation'      => '',
            'doc_url'          => '',
            'causes'           => [],
            'stack'            => $t->getTraceAsString(),
            'context_snapshot' => null,
            'http_status'      => 500,
            'retryable'        => false,
            'retry_after_ms'   => 0,
            'details'          => null,
        ];
    }

    /**
     * Derive an `UNCAUGHT_<TYPE>` code from a fully-qualified class name.
     * Mirrors the Python `UNCAUGHT_CONNECTIONERROR`, Go `UNCAUGHT_<TYPE>`,
     * Java `UNCAUGHT_IOEXCEPTION`, C# `UNCAUGHT_IOEXCEPTION`, and Ruby
     * `UNCAUGHT_IOERROR` conventions: simple (unqualified) class name,
     * alphanumerics only, uppercased.
     */
    public static function uncaughtCode(?string $className): string
    {
        if ($className === null || $className === '') {
            return 'UNCAUGHT_ERROR';
        }
        $parts = explode('\\', $className);
        $simple = end($parts) ?: $className;
        $upper = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $simple) ?? '');
        return $upper === '' ? 'UNCAUGHT_ERROR' : 'UNCAUGHT_' . $upper;
    }

    // ===== Internal helpers =================================================

    /**
     * @param array<string, mixed> $raw
     * @param array<int, string>   $keys
     */
    private static function pick(array $raw, array $keys): mixed
    {
        foreach ($keys as $k) {
            if (array_key_exists($k, $raw)) {
                return $raw[$k];
            }
        }
        return null;
    }

    /**
     * @param array<string, mixed> $raw
     * @param array<int, string>   $keys
     */
    private static function pickInt(array $raw, array $keys): ?int
    {
        $v = self::pick($raw, $keys);
        if (is_int($v)) return $v;
        if (is_float($v)) return (int) $v;
        if (is_string($v) && is_numeric($v)) return (int) $v;
        return null;
    }

    /**
     * @param array<string, mixed> $raw
     * @param array<int, string>   $keys
     */
    private static function pickBool(array $raw, array $keys): ?bool
    {
        $v = self::pick($raw, $keys);
        return is_bool($v) ? $v : null;
    }

    private static function parseAt(string $value): ?\DateTimeImmutable
    {
        try {
            return new \DateTimeImmutable($value);
        } catch (\Exception) {
            return null;
        }
    }
}
