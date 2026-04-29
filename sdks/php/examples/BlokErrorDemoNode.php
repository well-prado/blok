<?php

declare(strict_types=1);

namespace Blok\Blok\Examples;

use Blok\Blok\Errors\BlokError;
use Blok\Blok\Errors\BuildContextSnapshot;
use Blok\Blok\Node\NodeHandler;
use Blok\Blok\Types\Context;

/**
 * Example node demonstrating the structured {@see BlokError} API per master
 * plan §17.
 *
 * Used by the cross-language E2E test
 * (`core/runner/__tests__/integration/runtimes/php-grpc.integration.test.ts`)
 * to verify that a PHP-side structured error flows through the gRPC wire to
 * the runner with every field preserved (category, severity, code,
 * remediation, retryable hints, cause chain, context snapshot).
 *
 * Triggered via the `mode` config:
 * - `mode = "dependency"` (default) — throws `BlokError::dependency()` with
 *   a cause chain rooted in a {@see \RuntimeException}.
 * - `mode = "rate-limit"` — throws `BlokError::rateLimit()` with
 *   `retry_after_ms`.
 * - `mode = "validation"` — throws `BlokError::validation()` with
 *   `details["issues"]`.
 * - `mode = "ok"` — returns success.
 */
final class BlokErrorDemoNode implements NodeHandler
{
    public function execute(Context $ctx, array $config): mixed
    {
        $mode = $config['mode'] ?? 'dependency';
        if (!is_string($mode)) {
            $mode = 'dependency';
        }

        if ($mode === 'ok') {
            return ['ok' => true, 'language' => 'php'];
        }

        $snapshot = BuildContextSnapshot::of($config, $ctx->vars ?? []);

        if ($mode === 'rate-limit') {
            throw BlokError::rateLimit()
                ->code('UPSTREAM_RATE_LIMITED')
                ->message('Upstream API returned 429')
                ->description('GitHub API rate limit hit (5000 req/hr).')
                ->remediation('Wait until the X-RateLimit-Reset header timestamp.')
                ->retryAfterMs(60000)
                ->docUrl('https://docs.example.com/errors/rate-limit')
                ->details(['limit' => 5000, 'remaining' => 0])
                ->contextSnapshot($snapshot)
                ->build();
        }

        if ($mode === 'validation') {
            throw BlokError::validation()
                ->code('VALIDATION_FAILED')
                ->message('2 validation issues')
                ->description("Inputs didn't match the node's schema.")
                ->remediation('Provide both `email` and `name`.')
                ->details([
                    'issues' => [
                        ['path' => ['email'], 'message' => 'Required'],
                        ['path' => ['name'],  'message' => 'Required'],
                    ],
                ])
                ->contextSnapshot($snapshot)
                ->build();
        }

        // default: dependency with a cause chain rooted in a RuntimeException.
        $cause = new \RuntimeException('[Errno 61] Connection refused');
        throw BlokError::dependency()
            ->code('POSTGRES_CONNECT_TIMEOUT')
            ->message('Could not connect to Postgres within 5s')
            ->description('Tried host=db.internal port=5432; timeout=5000ms')
            ->remediation('Check DATABASE_URL env var and network reachability')
            ->cause($cause)
            ->retryable(true)
            ->retryAfterMs(5000)
            ->docUrl('https://docs.example.com/errors/POSTGRES_CONNECT_TIMEOUT')
            ->details(['host' => 'db.internal', 'port' => 5432, 'timeout_ms' => 5000])
            ->contextSnapshot($snapshot)
            ->build();
    }
}
