<?php

declare(strict_types=1);

namespace Blok;

/**
 * NodeRegistry manages registered node handlers.
 *
 * Nodes are registered by name and can be executed via the execute() method,
 * which is called by the HTTP server when a POST /execute request is received.
 */
class NodeRegistry
{
    /** @var array<string, NodeHandler> */
    private array $nodes = [];

    /**
     * Register a node handler with the given name.
     */
    public function register(string $name, NodeHandler $handler): void
    {
        $this->nodes[$name] = $handler;
    }

    /**
     * Get a node handler by name.
     *
     * @throws \RuntimeException If the node is not found.
     */
    public function get(string $name): NodeHandler
    {
        if (!isset($this->nodes[$name])) {
            throw new \RuntimeException("Node '{$name}' not found");
        }
        return $this->nodes[$name];
    }

    /**
     * Execute a node from an ExecutionRequest.
     *
     * Looks up the handler by the node name in the request, executes it with
     * the provided context and config, and returns an ExecutionResult.
     */
    public function execute(ExecutionRequest $request): ExecutionResult
    {
        $startTime = hrtime(true);

        try {
            $handler = $this->get($request->node->name);
            $data = $handler->execute($request->context, $request->node->config);

            $durationMs = (hrtime(true) - $startTime) / 1_000_000;

            $metrics = new ExecutionMetrics();
            $metrics->duration_ms = round($durationMs, 3);
            $metrics->memory_bytes = memory_get_peak_usage(true);

            return ExecutionResult::successWithMetrics($data, $metrics);
        } catch (\Throwable $e) {
            $durationMs = (hrtime(true) - $startTime) / 1_000_000;

            $result = ExecutionResult::errorWithDetails($e->getMessage(), [
                'type' => get_class($e),
                'file' => $e->getFile(),
                'line' => $e->getLine(),
            ]);

            $metrics = new ExecutionMetrics();
            $metrics->duration_ms = round($durationMs, 3);
            $result->metrics = $metrics;

            return $result;
        }
    }

    /**
     * Get the health status of the runtime.
     */
    public function getHealth(string $version): HealthStatus
    {
        return new HealthStatus($version, array_keys($this->nodes));
    }

    /**
     * Get the number of registered nodes.
     */
    public function size(): int
    {
        return count($this->nodes);
    }
}
