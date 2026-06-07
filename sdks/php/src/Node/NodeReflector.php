<?php

declare(strict_types=1);

namespace Blok\Blok\Node;

/**
 * Implemented by typed nodes (see {@see TypedNode}) to expose a description +
 * JSON Schema for the node catalog (GET /__blok/nodes) via gRPC ListNodes
 * (SPEC-B P4). Legacy {@see NodeHandler} nodes don't implement it.
 */
interface NodeReflector
{
    public function description(): string;

    /** @return array<string, mixed>|null JSON Schema for the input, or null. */
    public function inputSchema(): ?array;

    /** @return array<string, mixed>|null JSON Schema for the output, or null. */
    public function outputSchema(): ?array;
}
