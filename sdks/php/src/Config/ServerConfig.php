<?php

declare(strict_types=1);

namespace Blok\Blok\Config;

use Blok\Blok\Logging\LogLevel;

/**
 * Transport selector for the SDK server.
 *
 * - {@see Transport::Http} runs the existing ReactPHP HTTP server only.
 * - {@see Transport::Grpc} expects to be invoked by the RoadRunner daemon
 *   (`rr serve -c .rr.yaml`). The PHP worker enters the spiral/roadrunner-grpc
 *   `Server::serve()` loop and never binds a TCP port directly; the rr daemon
 *   handles HTTP/2 framing and dispatches to this worker.
 * - {@see Transport::Both} is documented but not orchestrated in-process by
 *   PHP — operators run `rr serve` and `php bin/serve.php` side by side.
 */
enum Transport: string
{
    case Http = 'http';
    case Grpc = 'grpc';
    case Both = 'both';

    public static function fromString(string $value): self
    {
        return match (strtolower($value)) {
            'grpc' => self::Grpc,
            'both' => self::Both,
            default => self::Http,
        };
    }
}

/**
 * ServerConfig holds server configuration loaded from environment variables.
 */
final class ServerConfig
{
    public function __construct(
        public readonly int $port = 9005,
        public readonly int $grpcPort = 10005,
        public readonly string $host = '0.0.0.0',
        public readonly string $version = '1.0.0',
        public readonly LogLevel $logLevel = LogLevel::Info,
        public readonly bool $enableCors = false,
        public readonly Transport $transport = Transport::Http,
    ) {}

    /**
     * Load configuration from environment variables with defaults.
     *
     * Environment variables:
     *   - PORT            (default: 9005)
     *   - GRPC_PORT       (default: 10005)  — read by .rr.yaml as well
     *   - HOST            (default: 0.0.0.0)
     *   - VERSION         (default: 1.0.0)
     *   - LOG_LEVEL       (default: INFO)
     *   - ENABLE_CORS     (default: false)
     *   - BLOK_TRANSPORT  (default: http)   — http | grpc | both
     */
    public static function fromEnv(): self
    {
        return new self(
            port: (int) (getenv('PORT') ?: '9005'),
            grpcPort: (int) (getenv('GRPC_PORT') ?: '10005'),
            host: getenv('HOST') ?: '0.0.0.0',
            version: getenv('VERSION') ?: '1.0.0',
            logLevel: LogLevel::fromString(getenv('LOG_LEVEL') ?: 'INFO'),
            enableCors: filter_var(getenv('ENABLE_CORS') ?: 'false', FILTER_VALIDATE_BOOLEAN),
            transport: Transport::fromString(getenv('BLOK_TRANSPORT') ?: 'http'),
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
