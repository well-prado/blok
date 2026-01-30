<?php

declare(strict_types=1);

namespace Blok\Blok\Testing;

use Blok\Blok\Node\NodeHandler;
use Blok\Blok\Node\NodeRegistry;
use Blok\Blok\Types\Context;
use Blok\Blok\Types\ExecutionRequest;
use Blok\Blok\Types\ExecutionResult;
use Blok\Blok\Types\NodeConfig;

/**
 * TestRunner executes nodes in-process for testing.
 */
final class TestRunner
{
    private readonly NodeRegistry $registry;

    public function __construct()
    {
        $this->registry = new NodeRegistry('test');
    }

    /**
     * Register a node for testing.
     */
    public function register(string $name, NodeHandler $handler): self
    {
        $this->registry->register($name, $handler);
        return $this;
    }

    /**
     * Execute a node with the given context and config.
     *
     * @param array<string, mixed> $config
     */
    public function execute(string $name, Context $ctx, array $config = []): ExecutionResult
    {
        $req = new ExecutionRequest(
            node: new NodeConfig(
                name: $name,
                config: $config,
            ),
            context: $ctx,
        );

        return $this->registry->execute($req);
    }

    /**
     * Assert that a result is successful and return the data.
     */
    public static function assertSuccess(ExecutionResult $result): mixed
    {
        if (!$result->success) {
            throw new \RuntimeException(
                sprintf('Expected success but got error: %s', json_encode($result->errors))
            );
        }
        return $result->data;
    }

    /**
     * Assert that a result is an error and return the error value.
     */
    public static function assertError(ExecutionResult $result): mixed
    {
        if ($result->success) {
            throw new \RuntimeException(
                sprintf('Expected error but got success: %s', json_encode($result->data))
            );
        }
        return $result->errors;
    }
}
