<?php

declare(strict_types=1);

namespace Blok\Nanoservice\Types;

/**
 * ExecutionRequest is the request received from the Blok runner.
 */
final class ExecutionRequest
{
    public function __construct(
        public NodeConfig $node = new NodeConfig(),
        public Context $context = new Context(),
    ) {}

    /**
     * Create an ExecutionRequest from an associative array.
     */
    public static function fromArray(array $data): self
    {
        return new self(
            node: isset($data['node']) ? NodeConfig::fromArray($data['node']) : new NodeConfig(),
            context: isset($data['context']) ? Context::fromArray($data['context']) : new Context(),
        );
    }

    /**
     * Convert to an associative array for JSON serialization.
     */
    public function toArray(): array
    {
        return [
            'node' => $this->node->toArray(),
            'context' => $this->context->toArray(),
        ];
    }
}
