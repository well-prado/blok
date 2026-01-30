<?php

declare(strict_types=1);

namespace Blok\Blok\Testing;

use Blok\Blok\Types\Context;
use Blok\Blok\Types\Request;
use Blok\Blok\Types\Response;

/**
 * MockContext provides a fluent builder for creating test Context instances.
 */
final class MockContext
{
    private string $id = 'test-execution-id';
    private string $workflowName = 'test-workflow';
    private string $workflowPath = '/workflows/test';
    private mixed $body = [];
    /** @var array<string, string> */
    private array $headers = [];
    private string $method = 'POST';
    private string $url = '/test';
    /** @var array<string, mixed> */
    private array $vars = [];
    /** @var array<string, string> */
    private array $env = [];
    /** @var array<string, string> */
    private array $params = [];
    /** @var array<string, string> */
    private array $query = [];

    /**
     * Create a new MockContext builder.
     */
    public static function create(): self
    {
        return new self();
    }

    /**
     * Set the execution ID.
     */
    public function withId(string $id): self
    {
        $this->id = $id;
        return $this;
    }

    /**
     * Set the workflow name and path.
     */
    public function withWorkflow(string $name, string $path): self
    {
        $this->workflowName = $name;
        $this->workflowPath = $path;
        return $this;
    }

    /**
     * Set the request body.
     */
    public function withBody(mixed $body): self
    {
        $this->body = $body;
        return $this;
    }

    /**
     * Set the request headers.
     *
     * @param array<string, string> $headers
     */
    public function withHeaders(array $headers): self
    {
        $this->headers = $headers;
        return $this;
    }

    /**
     * Set the request method.
     */
    public function withMethod(string $method): self
    {
        $this->method = $method;
        return $this;
    }

    /**
     * Set the request URL.
     */
    public function withUrl(string $url): self
    {
        $this->url = $url;
        return $this;
    }

    /**
     * Set a context variable.
     */
    public function withVar(string $key, mixed $value): self
    {
        $this->vars[$key] = $value;
        return $this;
    }

    /**
     * Set an environment variable.
     */
    public function withEnv(string $key, string $value): self
    {
        $this->env[$key] = $value;
        return $this;
    }

    /**
     * Set request params.
     *
     * @param array<string, string> $params
     */
    public function withParams(array $params): self
    {
        $this->params = $params;
        return $this;
    }

    /**
     * Set request query parameters.
     *
     * @param array<string, string> $query
     */
    public function withQuery(array $query): self
    {
        $this->query = $query;
        return $this;
    }

    /**
     * Build the Context instance.
     */
    public function build(): Context
    {
        return new Context(
            id: $this->id,
            workflowName: $this->workflowName,
            workflowPath: $this->workflowPath,
            request: new Request(
                body: $this->body,
                headers: $this->headers,
                params: $this->params,
                query: $this->query,
                method: $this->method,
                url: $this->url,
                baseUrl: 'http://localhost:8080',
            ),
            response: new Response(),
            vars: $this->vars,
            env: $this->env,
        );
    }
}
