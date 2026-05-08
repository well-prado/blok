<?php

declare(strict_types=1);

namespace Blok\Blok\Errors;

/**
 * How serious an error is. Mirrors the proto `blok.runtime.v1.ErrorSeverity`
 * enum. Default for thrown errors is {@see self::Error}.
 */
enum BlokErrorSeverity: string
{
    /** Informational, no action needed. */
    case Info = 'INFO';
    /** Recoverable, worth surfacing. */
    case Warn = 'WARN';
    /** Standard error level. */
    case Error = 'ERROR';
    /** Process must terminate. */
    case Fatal = 'FATAL';

    /** Parse a wire string, falling back to {@see self::Error}. */
    public static function parse(?string $value): self
    {
        if ($value === null) {
            return self::Error;
        }
        return self::tryFrom($value) ?? self::Error;
    }
}
