<?php

declare(strict_types=1);

namespace Blok\Nanoservice\Server;

use Blok\Nanoservice\Node\NodeHandler;

/**
 * MiddlewarePipeline chains multiple middleware around a handler.
 */
final class MiddlewarePipeline
{
    /**
     * @param Middleware[] $middlewares
     */
    public function __construct(
        private readonly array $middlewares = [],
    ) {}

    /**
     * Apply the middleware chain to a handler.
     * Middlewares are applied in order, so the last middleware is the outermost wrapper.
     */
    public function wrap(NodeHandler $handler): NodeHandler
    {
        $current = $handler;
        foreach ($this->middlewares as $middleware) {
            $current = $middleware->wrap($current);
        }
        return $current;
    }
}
