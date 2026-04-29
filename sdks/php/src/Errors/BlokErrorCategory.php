<?php

declare(strict_types=1);

namespace Blok\Blok\Errors;

/**
 * The 12 canonical error categories every Blok node error falls into.
 *
 * Mirrors the proto `blok.runtime.v1.ErrorCategory` enum value-for-value and
 * matches the Python `BlokErrorCategory`, Go `CategoryDependency`, Rust
 * `BlokErrorCategory::Dependency`, Java `BlokErrorCategory.DEPENDENCY`, C#
 * `BlokErrorCategory.Dependency`, and Ruby `Category::DEPENDENCY` constants.
 * Each category carries a default HTTP status and retryable hint that authors
 * can override per-error via the builder.
 */
enum BlokErrorCategory: string
{
    /** Input failed schema validation. Default HTTP 400, non-retryable. */
    case Validation = 'VALIDATION';
    /** Misconfiguration of the runner / node / environment. Default 500, non-retryable. */
    case Configuration = 'CONFIGURATION';
    /** External dependency unreachable (DB, API). Default 502, retryable. */
    case Dependency = 'DEPENDENCY';
    /** Deadline exceeded. Default 504, retryable. */
    case Timeout = 'TIMEOUT';
    /** Caller lacks the right role/scope. Default 403, non-retryable. */
    case Permission = 'PERMISSION';
    /** Caller exceeded a quota. Default 429, retryable with retry_after_ms. */
    case RateLimit = 'RATE_LIMIT';
    /** Resource not found. Default 404, non-retryable. */
    case NotFound = 'NOT_FOUND';
    /** Idempotency violation, concurrent update. Default 409, non-retryable. */
    case Conflict = 'CONFLICT';
    /** Caller cancelled before completion. Default 499, non-retryable. */
    case Cancelled = 'CANCELLED';
    /** SDK threw without classification — default fallback. Default 500, non-retryable. */
    case Internal = 'INTERNAL';
    /** Wire-format / framing / serialization error. Default 502, non-retryable. */
    case Protocol = 'PROTOCOL';
    /** Payload schema OK but values are unprocessable. Default 422, non-retryable. */
    case Data = 'DATA';

    /** HTTP status conventionally associated with this category. */
    public function defaultHttpStatus(): int
    {
        return match ($this) {
            self::Validation => 400,
            self::Configuration => 500,
            self::Dependency => 502,
            self::Timeout => 504,
            self::Permission => 403,
            self::RateLimit => 429,
            self::NotFound => 404,
            self::Conflict => 409,
            self::Cancelled => 499,
            self::Internal => 500,
            self::Protocol => 502,
            self::Data => 422,
        };
    }

    /** Retryable hint conventionally associated with this category. */
    public function defaultRetryable(): bool
    {
        return match ($this) {
            self::Dependency, self::Timeout, self::RateLimit => true,
            default => false,
        };
    }

    /**
     * Parse a wire string into a category, falling back to {@see self::Internal}
     * for unknown values (matches Python/Go/Rust/Java/C#/Ruby behaviour).
     */
    public static function parse(?string $value): self
    {
        if ($value === null) {
            return self::Internal;
        }
        return self::tryFrom($value) ?? self::Internal;
    }
}
