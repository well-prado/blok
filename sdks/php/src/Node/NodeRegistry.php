<?php

declare(strict_types=1);

namespace Blok\Blok\Node;

use Blok\Blok\Errors\BlokError;
use Blok\Blok\Server\Middleware;
use Blok\Blok\Server\MiddlewarePipeline;
use Blok\Blok\Types\ExecutionMetrics;
use Blok\Blok\Types\ExecutionRequest;
use Blok\Blok\Types\ExecutionResult;
use Blok\Blok\Types\HealthStatus;

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
        } catch (BlokError $e) {
            // Structured BlokError path (master plan §17): pass the instance
            // through verbatim so the gRPC servicer can serialize every field
            // (category, severity, remediation, retryable hints, cause chain,
            // context snapshot, etc.) into the proto NodeError.
            $durationMs = (hrtime(true) - $startTime) / 1_000_000;
            $memoryBytes = memory_get_peak_usage(true);

            $result = new ExecutionResult(
                success: false,
                data: null,
                errors: $e,
            );
            $result->withMetrics(new ExecutionMetrics(
                durationMs: round($durationMs, 3),
                memoryBytes: $memoryBytes,
            ));

            return $result;
        } catch (\Throwable $e) {
            // Preserve the typed Throwable on `errors` so the gRPC servicer's
            // `internalErrorToProto` can derive `UNCAUGHT_<TYPE>` from the
            // exception class via `BlokError::fromUnknown` per §17.7.
            // (PHP's `mixed` type lets us store the instance directly,
            // mirroring Rust's typed-error preservation.)
            $durationMs = (hrtime(true) - $startTime) / 1_000_000;
            $memoryBytes = memory_get_peak_usage(true);

            $result = new ExecutionResult(
                success: false,
                data: null,
                errors: $e,
            );
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
