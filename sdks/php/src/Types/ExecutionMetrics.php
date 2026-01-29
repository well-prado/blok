<?php

declare(strict_types=1);

namespace Blok\Nanoservice\Types;

/**
 * ExecutionMetrics captures performance metrics for a node execution.
 */
final class ExecutionMetrics
{
    public function __construct(
        public ?float $durationMs = null,
        public ?float $cpuMs = null,
        public ?int $memoryBytes = null,
    ) {}

    /**
     * Create an ExecutionMetrics from an associative array.
     */
    public static function fromArray(array $data): self
    {
        return new self(
            durationMs: $data['duration_ms'] ?? null,
            cpuMs: $data['cpu_ms'] ?? null,
            memoryBytes: isset($data['memory_bytes']) ? (int) $data['memory_bytes'] : null,
        );
    }

    /**
     * Convert to an associative array for JSON serialization.
     * Omits null values.
     */
    public function toArray(): array
    {
        $result = [];
        if ($this->durationMs !== null) {
            $result['duration_ms'] = $this->durationMs;
        }
        if ($this->cpuMs !== null) {
            $result['cpu_ms'] = $this->cpuMs;
        }
        if ($this->memoryBytes !== null) {
            $result['memory_bytes'] = $this->memoryBytes;
        }
        return $result;
    }
}
