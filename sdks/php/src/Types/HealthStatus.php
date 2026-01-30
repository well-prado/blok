<?php

declare(strict_types=1);

namespace Blok\Blok\Types;

/**
 * HealthStatus represents the health status of the runtime.
 */
final class HealthStatus
{
    public function __construct(
        public string $status = 'healthy',
        public string $version = '1.0.0',
        /** @var string[] */
        public array $nodesLoaded = [],
    ) {}

    /**
     * Create a HealthStatus from an associative array.
     */
    public static function fromArray(array $data): self
    {
        return new self(
            status: $data['status'] ?? 'healthy',
            version: $data['version'] ?? '1.0.0',
            nodesLoaded: $data['nodes_loaded'] ?? [],
        );
    }

    /**
     * Convert to an associative array for JSON serialization.
     */
    public function toArray(): array
    {
        return [
            'status' => $this->status,
            'version' => $this->version,
            'nodes_loaded' => $this->nodesLoaded,
        ];
    }
}
