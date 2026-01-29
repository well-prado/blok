<?php

declare(strict_types=1);

namespace Blok\Nanoservice\Logging;

/**
 * LogLevel represents the severity of a log entry.
 */
enum LogLevel: string
{
    case Debug = 'DEBUG';
    case Info = 'INFO';
    case Warn = 'WARN';
    case Error = 'ERROR';

    /**
     * Get the numeric priority of this level (lower = less severe).
     */
    public function priority(): int
    {
        return match ($this) {
            self::Debug => 0,
            self::Info => 1,
            self::Warn => 2,
            self::Error => 3,
        };
    }

    /**
     * Check if this level is at least as severe as the given level.
     */
    public function isAtLeast(self $level): bool
    {
        return $this->priority() >= $level->priority();
    }

    /**
     * Create a LogLevel from a string, defaulting to Info.
     */
    public static function fromString(string $level): self
    {
        return match (strtoupper($level)) {
            'DEBUG' => self::Debug,
            'WARN', 'WARNING' => self::Warn,
            'ERROR' => self::Error,
            default => self::Info,
        };
    }
}
