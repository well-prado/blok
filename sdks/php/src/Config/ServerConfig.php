<?php

declare(strict_types=1);

namespace Blok\Blok\Config;

use Blok\Blok\Logging\LogLevel;

/**
 * ServerConfig holds server configuration loaded from environment variables.
 */
final class ServerConfig
{
    public function __construct(
        public readonly int $port = 8080,
        public readonly string $host = '0.0.0.0',
        public readonly string $version = '1.0.0',
        public readonly LogLevel $logLevel = LogLevel::Info,
        public readonly bool $enableCors = false,
    ) {}

    /**
     * Load configuration from environment variables with defaults.
     *
     * Environment variables:
     *   - PORT (default: 8080)
     *   - HOST (default: 0.0.0.0)
     *   - VERSION (default: 1.0.0)
     *   - LOG_LEVEL (default: INFO)
     *   - ENABLE_CORS (default: false)
     */
    public static function fromEnv(): self
    {
        return new self(
            port: (int) (getenv('PORT') ?: '8080'),
            host: getenv('HOST') ?: '0.0.0.0',
            version: getenv('VERSION') ?: '1.0.0',
            logLevel: LogLevel::fromString(getenv('LOG_LEVEL') ?: 'INFO'),
            enableCors: filter_var(getenv('ENABLE_CORS') ?: 'false', FILTER_VALIDATE_BOOLEAN),
        );
    }

    /**
     * Return the bind address as host:port.
     */
    public function address(): string
    {
        return sprintf('%s:%d', $this->host, $this->port);
    }
}
