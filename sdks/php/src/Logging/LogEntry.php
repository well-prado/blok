<?php

declare(strict_types=1);

namespace Blok\Nanoservice\Logging;

/**
 * LogEntry represents a single log entry.
 */
final class LogEntry
{
    public function __construct(
        public readonly LogLevel $level,
        public readonly string $message,
        public readonly string $timestamp,
        public readonly ?array $fields = null,
    ) {}

    /**
     * Format the entry as a human-readable string.
     */
    public function __toString(): string
    {
        $base = sprintf('[%s] %s %s', $this->level->value, $this->timestamp, $this->message);
        if ($this->fields !== null) {
            $json = json_encode($this->fields, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            return $base . ' ' . ($json ?: '{}');
        }
        return $base;
    }

    /**
     * Convert to an associative array for JSON serialization.
     */
    public function toArray(): array
    {
        $result = [
            'level' => $this->level->value,
            'message' => $this->message,
            'timestamp' => $this->timestamp,
        ];
        if ($this->fields !== null) {
            $result['fields'] = $this->fields;
        }
        return $result;
    }
}
