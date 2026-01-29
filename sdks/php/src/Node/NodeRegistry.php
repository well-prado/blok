<?php

declare(strict_types=1);

namespace Blok\Nanoservice\Node;

use Blok\Nanoservice\Server\Middleware;
use Blok\Nanoservice\Server\MiddlewarePipeline;
use Blok\Nanoservice\Types\ExecutionMetrics;
use Blok\Nanoservice\Types\ExecutionRequest;
use Blok\Nanoservice\Types\ExecutionResult;
use Blok\Nanoservice\Types\HealthStatus;

/**
 * NodeRegistry manages registered node handlers and dispatches execution requests.
 */
final class NodeRegistry
{
    /** @var array<string, NodeHandler> */
    private array $nodes = [];

    /** @var Middleware[] */
    private array $middlewares = [];

    public function __construct(
        private readonly string $version = '1.0.0',
    ) {}

    /**
     * Register a node handler under the given name.
     */
    public function register(string $name, NodeHandler $handler): void
    {
        $this->nodes[$name] = $handler;
    }

    /**
     * Add middleware to the registry.
     */
    public function useMiddleware(Middleware $middleware): void
    {
        $this->middlewares[] = $middleware;
    }

    /**
     * Look up a node handler by name.
     */
    public function get(string $name): ?NodeHandler
    {
        return $this->nodes[$name] ?? null;
    }

    /**
     * Return the names of all registered nodes.
     *
     * @return string[]
     */
    public function nodeNames(): array
    {
        return array_keys($this->nodes);
    }

    /**
     * Return the number of registered nodes.
     */
    public function count(): int
    {
        return count($this->nodes);
    }

    /**
     * Return whether the registry is empty.
     */
    public function isEmpty(): bool
    {
        return empty($this->nodes);
    }

    /**
     * Execute a node by dispatching through the registry.
     */
    public function execute(ExecutionRequest $req): ExecutionResult
    {
        $handler = $this->get($req->node->name);
        if ($handler === null) {
            return ExecutionResult::error(
                sprintf("node '%s' not found in registry", $req->node->name)
            );
        }

        // Apply middleware chain
        if (!empty($this->middlewares)) {
            $pipeline = new MiddlewarePipeline($this->middlewares);
            $handler = $pipeline->wrap($handler);
        }

        $startTime = hrtime(true);

        try {
            $data = $handler->execute($req->context, $req->node->config);
            $durationMs = (hrtime(true) - $startTime) / 1_000_000;
            $memoryBytes = memory_get_peak_usage(true);

            $result = ExecutionResult::successWithMetrics(
                $data,
                new ExecutionMetrics(
                    durationMs: round($durationMs, 3),
                    memoryBytes: $memoryBytes,
                ),
            );

            // Include context vars so the runner can propagate them downstream
            if (!empty($req->context->vars)) {
                $result->withVars($req->context->vars);
            }

            return $result;
        } catch (\Throwable $e) {
            $durationMs = (hrtime(true) - $startTime) / 1_000_000;
            $memoryBytes = memory_get_peak_usage(true);

            $result = ExecutionResult::error($e->getMessage());
            $result->withMetrics(new ExecutionMetrics(
                durationMs: round($durationMs, 3),
                memoryBytes: $memoryBytes,
            ));

            return $result;
        }
    }

    /**
     * Return the health status.
     */
    public function health(): HealthStatus
    {
        return new HealthStatus(
            status: 'healthy',
            version: $this->version,
            nodesLoaded: $this->nodeNames(),
        );
    }
}
