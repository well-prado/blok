<?php

declare(strict_types=1);

namespace Blok\Nanoservice\Server;

use Blok\Nanoservice\Node\NodeHandler;

/**
 * Middleware wraps a NodeHandler to add cross-cutting behavior.
 */
interface Middleware
{
    /**
     * Wrap a handler and return a new handler with additional behavior.
     */
    public function wrap(NodeHandler $next): NodeHandler;
}
