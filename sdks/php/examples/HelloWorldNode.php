<?php

declare(strict_types=1);

namespace Blok\Blok\Examples;

use Blok\Blok\Node\NodeHandler;
use Blok\Blok\Types\Context;

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
