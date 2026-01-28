<?php

declare(strict_types=1);

namespace Blok\Nodes;

use Blok\Context;
use Blok\NodeHandler;

/**
 * HelloWorldNode is an example Blok node in PHP.
 *
 * Reads "name" from the request body and "prefix" from node config,
 * then returns a greeting message.
 */
class HelloWorldNode implements NodeHandler
{
    /**
     * Execute the hello world node.
     *
     * @param Context $ctx    The workflow execution context.
     * @param array   $config Node-specific configuration (supports "prefix" key).
     * @return array The result containing message, timestamp, and language.
     */
    public function execute(Context $ctx, array $config): mixed
    {
        // Get name from request body or use default
        $name = 'World';
        if (is_array($ctx->request->body) && isset($ctx->request->body['name'])) {
            $name = (string) $ctx->request->body['name'];
        }

        // Get greeting prefix from config or use default
        $prefix = $config['prefix'] ?? 'Hello';

        $message = "{$prefix}, {$name}!";

        // Store in context vars for downstream nodes
        $ctx->vars['greeting'] = $message;
        $ctx->vars['timestamp'] = time();

        // Return response
        return [
            'message' => $message,
            'timestamp' => date('c'),
            'language' => 'PHP',
        ];
    }
}
