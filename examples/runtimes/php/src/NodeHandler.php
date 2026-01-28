<?php

declare(strict_types=1);

namespace Blok;

/**
 * NodeHandler is the interface that all Blok nodes must implement.
 *
 * Each node receives the workflow execution context and a configuration map,
 * and returns the result data or throws an exception on failure.
 */
interface NodeHandler
{
    /**
     * Execute the node logic.
     *
     * @param Context $ctx    The workflow execution context.
     * @param array   $config Node-specific configuration from the workflow definition.
     * @return mixed The result data to be returned to the Blok runner.
     * @throws \Exception If the node execution fails.
     */
    public function execute(Context $ctx, array $config): mixed;
}
