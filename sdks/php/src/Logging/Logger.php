<?php

declare(strict_types=1);

namespace Blok\Blok\Logging;

/**
 * Logger captures log entries for inclusion in ExecutionResult.logs.
 *
 * Provides level-based filtering and a capture buffer that can be
 * retrieved as structured entries or formatted lines.
 */
final class Logger
{
    /** @var LogEntry[] */
    private array $entries = [];

    public function __construct(
        private readonly LogLevel $minLevel = LogLevel::Info,
    ) {}

    /**
     * Log a message at the given level.
     */
    private function log(LogLevel $level, string $message, ?array $fields = null): void
    {
        if (!$level->isAtLeast($this->minLevel)) {
            return;
        }

        $this->entries[] = new LogEntry(
            level: $level,
            message: $message,
            timestamp: gmdate('Y-m-d\TH:i:s\Z'),
            fields: $fields,
        );
    }

    /**
     * Log a debug message.
     */
    public function debug(string $message): void
    {
        $this->log(LogLevel::Debug, $message);
    }

    /**
     * Log a debug message with fields.
     */
    public function debugWith(string $message, array $fields): void
    {
        $this->log(LogLevel::Debug, $message, $fields);
    }

    /**
     * Log an info message.
     */
    public function info(string $message): void
    {
        $this->log(LogLevel::Info, $message);
    }

    /**
     * Log an info message with fields.
     */
    public function infoWith(string $message, array $fields): void
    {
        $this->log(LogLevel::Info, $message, $fields);
    }

    /**
     * Log a warning message.
     */
    public function warn(string $message): void
    {
        $this->log(LogLevel::Warn, $message);
    }

    /**
     * Log a warning message with fields.
     */
    public function warnWith(string $message, array $fields): void
    {
        $this->log(LogLevel::Warn, $message, $fields);
    }

    /**
     * Log an error message.
     */
    public function error(string $message): void
    {
        $this->log(LogLevel::Error, $message);
    }

    /**
     * Log an error message with fields.
     */
    public function errorWith(string $message, array $fields): void
    {
        $this->log(LogLevel::Error, $message, $fields);
    }

    /**
     * Get all captured log entries.
     *
     * @return LogEntry[]
     */
    public function entries(): array
    {
        return $this->entries;
    }

    /**
     * Get log entries as formatted strings for ExecutionResult.logs.
     *
     * @return string[]
     */
    public function lines(): array
    {
        return array_map(
            static fn (LogEntry $entry): string => (string) $entry,
            $this->entries,
        );
    }

    /**
     * Clear all captured entries.
     */
    public function clear(): void
    {
        $this->entries = [];
    }
}
