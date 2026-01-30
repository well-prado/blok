<?php

declare(strict_types=1);

namespace Blok\Blok\Node;

use Blok\Blok\Types\Context;

/**
 * NodeHandler is the core interface that all Blok nodes must implement.
 *
 * Example:
 * ```php
 * class MyNode implements NodeHandler
 * {
 *     public function execute(Context $ctx, array $config): mixed
 *     {
 *         $name = $ctx->request->bodyStr('name') ?? 'World';
 *         return ['message' => "Hello, {$name}!"];
 *     }
 * }
 * ```
 */
interface NodeHandler
{
    /**
     * Execute the node logic with the given workflow context and node configuration.
     *
     * @param Context $ctx The workflow execution context
     * @param array<string, mixed> $config Node-specific configuration
     * @return mixed The result data to include in the ExecutionResult
     * @throws \Throwable On execution failure
     */
    public function execute(Context $ctx, array $config): mixed;
}
