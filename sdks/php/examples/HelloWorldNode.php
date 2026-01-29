<?php

declare(strict_types=1);

namespace Blok\Nanoservice\Examples;

use Blok\Nanoservice\Node\NodeHandler;
use Blok\Nanoservice\Types\Context;

/**
 * HelloWorldNode greets the user with a configurable prefix.
 *
 * Config:
 *   - prefix (string, optional): Greeting prefix (default: "Hello")
 *
 * Body:
 *   - name (string, optional): Name to greet (default: "World")
 */
final class HelloWorldNode implements NodeHandler
{
    public function execute(Context $ctx, array $config): mixed
    {
        $name = $ctx->request->bodyStr('name') ?? 'World';
        $prefix = isset($config['prefix']) && is_string($config['prefix'])
            ? $config['prefix']
            : 'Hello';

        $message = sprintf('%s, %s!', $prefix, $name);

        // Store greeting in context for downstream nodes
        $ctx->setVar('greeting', $message);

        return [
            'message' => $message,
            'timestamp' => gmdate('Y-m-d\TH:i:s\Z'),
            'language' => 'php',
        ];
    }
}
