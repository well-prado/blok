<?php

declare(strict_types=1);

namespace Blok\Blok\Examples;

use Blok\Blok\Node\NodeHandler;
use Blok\Blok\Types\Context;

/**
 * ChainTestNode is used in cross-runtime integration tests.
 * It reads a chain array from the request body, appends its own entry,
 * and returns the updated chain — proving data flows between languages.
 */
final class ChainTestNode implements NodeHandler
{
    public function execute(Context $ctx, array $config): mixed
    {
        $body = $ctx->request->body;

        // Read existing chain — gRPC inputs first (carried on
        // `node.config`), HTTP body fallback (legacy wire shape where
        // the runner mapped resolvedInputs → request.body). Dual-read
        // keeps the cross-runtime-chain demo working over both
        // transports during the §11 deprecation window.
        $chain = [];
        if (isset($config['chain']) && is_array($config['chain'])) {
            $chain = $config['chain'];
        } elseif (is_array($body) && isset($body['chain']) && is_array($body['chain'])) {
            $chain = $body['chain'];
        }

        // Read origin — same dual-read.
        $origin = 'unknown';
        if (isset($config['origin']) && is_string($config['origin']) && $config['origin'] !== '') {
            $origin = $config['origin'];
        } elseif (is_array($body) && isset($body['origin']) && is_string($body['origin'])) {
            $origin = $body['origin'];
        }

        // Append this language's entry
        $chain[] = [
            'language' => 'php',
            'order' => count($chain) + 1,
            'timestamp' => gmdate('Y-m-d\TH:i:s\Z'),
        ];

        // Store in context vars
        $ctx->setVar('chain', $chain);

        return [
            'chain' => $chain,
            'origin' => $origin,
        ];
    }
}
