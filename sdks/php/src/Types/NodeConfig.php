<?php

declare(strict_types=1);

namespace Blok\Blok\Types;

/**
 * NodeConfig represents node-specific configuration from the runner.
 */
final class NodeConfig
{
    public function __construct(
        public string $name = '',
        public string $path = '',
        public string $type = '',
        /** @var array<string, mixed> */
        public array $config = [],
    ) {}

    /**
     * Get a string config value with a default.
     */
    public function configStr(string $key, string $default = ''): string
    {
        $val = $this->config[$key] ?? null;
        return is_string($val) ? $val : $default;
    }

    /**
     * Get an integer config value with a default.
     */
    public function configInt(string $key, int $default = 0): int
    {
        $val = $this->config[$key] ?? null;
        return is_int($val) ? $val : (is_numeric($val) ? (int) $val : $default);
    }

    /**
     * Get a boolean config value with a default.
     */
    public function configBool(string $key, bool $default = false): bool
    {
        $val = $this->config[$key] ?? null;
        return is_bool($val) ? $val : $default;
    }

    /**
     * Create a NodeConfig from an associative array.
     */
    public static function fromArray(array $data): self
    {
        return new self(
            name: $data['name'] ?? '',
            path: $data['path'] ?? '',
            type: $data['type'] ?? '',
            config: $data['config'] ?? [],
        );
    }

    /**
     * Convert to an associative array for JSON serialization.
     */
    public function toArray(): array
    {
        return [
            'name' => $this->name,
            'path' => $this->path,
            'type' => $this->type,
            'config' => $this->config,
        ];
    }
}
