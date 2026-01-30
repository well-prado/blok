<?php

declare(strict_types=1);

namespace Blok\Blok\Types;

/**
 * Context represents the workflow execution context passed between nodes.
 */
final class Context
{
    public function __construct(
        public string $id = '',
        public string $workflowName = '',
        public string $workflowPath = '',
        public Request $request = new Request(),
        public Response $response = new Response(),
        /** @var array<string, mixed> */
        public array $vars = [],
        /** @var array<string, string> */
        public array $env = [],
    ) {}

    /**
     * Store a variable in context for downstream nodes.
     */
    public function setVar(string $key, mixed $value): void
    {
        $this->vars[$key] = $value;
    }

    /**
     * Retrieve a variable from context.
     */
    public function getVar(string $key): mixed
    {
        return $this->vars[$key] ?? null;
    }

    /**
     * Retrieve a string variable from context.
     */
    public function getVarStr(string $key): ?string
    {
        $val = $this->vars[$key] ?? null;
        return is_string($val) ? $val : null;
    }

    /**
     * Create a Context from an associative array.
     */
    public static function fromArray(array $data): self
    {
        return new self(
            id: $data['id'] ?? '',
            workflowName: $data['workflow_name'] ?? '',
            workflowPath: $data['workflow_path'] ?? '',
            request: isset($data['request']) ? Request::fromArray($data['request']) : new Request(),
            response: isset($data['response']) ? Response::fromArray($data['response']) : new Response(),
            vars: $data['vars'] ?? [],
            env: $data['env'] ?? [],
        );
    }

    /**
     * Convert to an associative array for JSON serialization.
     */
    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'workflow_name' => $this->workflowName,
            'workflow_path' => $this->workflowPath,
            'request' => $this->request->toArray(),
            'response' => $this->response->toArray(),
            'vars' => $this->vars,
            'env' => $this->env,
        ];
    }
}
