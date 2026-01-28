<?php

declare(strict_types=1);

namespace Blok;

/**
 * Context represents the workflow execution context passed between nodes.
 */
class Context
{
    public string $id;
    public string $workflow_name;
    public string $workflow_path;
    public Request $request;
    public Response $response;
    /** @var array<string, mixed> */
    public array $vars;
    /** @var array<string, string> */
    public array $env;

    public function __construct()
    {
        $this->id = '';
        $this->workflow_name = '';
        $this->workflow_path = '';
        $this->request = new Request();
        $this->response = new Response();
        $this->vars = [];
        $this->env = [];
    }

    public static function fromArray(array $data): self
    {
        $ctx = new self();
        $ctx->id = $data['id'] ?? '';
        $ctx->workflow_name = $data['workflow_name'] ?? '';
        $ctx->workflow_path = $data['workflow_path'] ?? '';
        $ctx->request = Request::fromArray($data['request'] ?? []);
        $ctx->response = Response::fromArray($data['response'] ?? []);
        $ctx->vars = $data['vars'] ?? [];
        $ctx->env = $data['env'] ?? [];
        return $ctx;
    }

    public function toArray(): array
    {
        return [
            'id' => $this->id,
            'workflow_name' => $this->workflow_name,
            'workflow_path' => $this->workflow_path,
            'request' => $this->request->toArray(),
            'response' => $this->response->toArray(),
            'vars' => $this->vars,
            'env' => $this->env,
        ];
    }
}

/**
 * Request represents the incoming HTTP request data.
 */
class Request
{
    public mixed $body;
    /** @var array<string, string> */
    public array $headers;
    /** @var array<string, string> */
    public array $params;
    /** @var array<string, string> */
    public array $query;
    public string $method;
    public string $url;
    /** @var array<string, string> */
    public array $cookies;
    public string $baseUrl;

    public function __construct()
    {
        $this->body = null;
        $this->headers = [];
        $this->params = [];
        $this->query = [];
        $this->method = '';
        $this->url = '';
        $this->cookies = [];
        $this->baseUrl = '';
    }

    public static function fromArray(array $data): self
    {
        $req = new self();
        $req->body = $data['body'] ?? null;
        $req->headers = $data['headers'] ?? [];
        $req->params = $data['params'] ?? [];
        $req->query = $data['query'] ?? [];
        $req->method = $data['method'] ?? '';
        $req->url = $data['url'] ?? '';
        $req->cookies = $data['cookies'] ?? [];
        $req->baseUrl = $data['baseUrl'] ?? '';
        return $req;
    }

    public function toArray(): array
    {
        return [
            'body' => $this->body,
            'headers' => $this->headers,
            'params' => $this->params,
            'query' => $this->query,
            'method' => $this->method,
            'url' => $this->url,
            'cookies' => $this->cookies,
            'baseUrl' => $this->baseUrl,
        ];
    }
}

/**
 * Response represents the workflow response.
 */
class Response
{
    public mixed $data;
    public string $contentType;
    public bool $success;
    public mixed $error;

    public function __construct()
    {
        $this->data = null;
        $this->contentType = '';
        $this->success = true;
        $this->error = null;
    }

    public static function fromArray(array $data): self
    {
        $resp = new self();
        $resp->data = $data['data'] ?? null;
        $resp->contentType = $data['contentType'] ?? '';
        $resp->success = $data['success'] ?? true;
        $resp->error = $data['error'] ?? null;
        return $resp;
    }

    public function toArray(): array
    {
        return [
            'data' => $this->data,
            'contentType' => $this->contentType,
            'success' => $this->success,
            'error' => $this->error,
        ];
    }
}

/**
 * NodeConfig represents node-specific configuration from the runner.
 */
class NodeConfig
{
    public string $name;
    public string $path;
    /** @var array<string, mixed> */
    public array $config;

    public function __construct()
    {
        $this->name = '';
        $this->path = '';
        $this->config = [];
    }

    public static function fromArray(array $data): self
    {
        $cfg = new self();
        $cfg->name = $data['name'] ?? '';
        $cfg->path = $data['path'] ?? '';
        $cfg->config = $data['config'] ?? [];
        return $cfg;
    }

    public function toArray(): array
    {
        return [
            'name' => $this->name,
            'path' => $this->path,
            'config' => $this->config,
        ];
    }
}

/**
 * ExecutionRequest is the request received from the Blok runner.
 */
class ExecutionRequest
{
    public NodeConfig $node;
    public Context $context;

    public function __construct()
    {
        $this->node = new NodeConfig();
        $this->context = new Context();
    }

    public static function fromArray(array $data): self
    {
        $req = new self();
        $req->node = NodeConfig::fromArray($data['node'] ?? []);
        $req->context = Context::fromArray($data['context'] ?? []);
        return $req;
    }

    public function toArray(): array
    {
        return [
            'node' => $this->node->toArray(),
            'context' => $this->context->toArray(),
        ];
    }
}

/**
 * ExecutionMetrics captures performance metrics for a node execution.
 */
class ExecutionMetrics
{
    public ?float $duration_ms;
    public ?float $cpu_ms;
    public ?int $memory_bytes;

    public function __construct()
    {
        $this->duration_ms = null;
        $this->cpu_ms = null;
        $this->memory_bytes = null;
    }

    public static function fromArray(array $data): self
    {
        $metrics = new self();
        $metrics->duration_ms = isset($data['duration_ms']) ? (float) $data['duration_ms'] : null;
        $metrics->cpu_ms = isset($data['cpu_ms']) ? (float) $data['cpu_ms'] : null;
        $metrics->memory_bytes = isset($data['memory_bytes']) ? (int) $data['memory_bytes'] : null;
        return $metrics;
    }

    public function toArray(): array
    {
        $result = [];
        if ($this->duration_ms !== null) {
            $result['duration_ms'] = $this->duration_ms;
        }
        if ($this->cpu_ms !== null) {
            $result['cpu_ms'] = $this->cpu_ms;
        }
        if ($this->memory_bytes !== null) {
            $result['memory_bytes'] = $this->memory_bytes;
        }
        return $result;
    }
}

/**
 * ExecutionResult is the response returned to the Blok runner.
 */
class ExecutionResult
{
    public bool $success;
    public mixed $data;
    public mixed $errors;
    /** @var string[]|null */
    public ?array $logs;
    public ?ExecutionMetrics $metrics;

    public function __construct(bool $success = true, mixed $data = null, mixed $errors = null)
    {
        $this->success = $success;
        $this->data = $data;
        $this->errors = $errors;
        $this->logs = null;
        $this->metrics = null;
    }

    /**
     * Create a successful execution result.
     */
    public static function success(mixed $data): self
    {
        return new self(true, $data, null);
    }

    /**
     * Create a successful execution result with metrics.
     */
    public static function successWithMetrics(mixed $data, ExecutionMetrics $metrics): self
    {
        $result = new self(true, $data, null);
        $result->metrics = $metrics;
        return $result;
    }

    /**
     * Create an error execution result.
     */
    public static function error(string $message): self
    {
        return new self(false, null, ['message' => $message]);
    }

    /**
     * Create an error execution result with details.
     */
    public static function errorWithDetails(string $message, mixed $details): self
    {
        return new self(false, null, [
            'message' => $message,
            'details' => $details,
        ]);
    }

    public static function fromArray(array $data): self
    {
        $result = new self();
        $result->success = $data['success'] ?? true;
        $result->data = $data['data'] ?? null;
        $result->errors = $data['errors'] ?? null;
        $result->logs = $data['logs'] ?? null;
        if (isset($data['metrics'])) {
            $result->metrics = ExecutionMetrics::fromArray($data['metrics']);
        }
        return $result;
    }

    public function toArray(): array
    {
        $result = [
            'success' => $this->success,
            'data' => $this->data,
            'errors' => $this->errors,
        ];
        if ($this->logs !== null) {
            $result['logs'] = $this->logs;
        }
        if ($this->metrics !== null) {
            $metricsArray = $this->metrics->toArray();
            if (!empty($metricsArray)) {
                $result['metrics'] = $metricsArray;
            }
        }
        return $result;
    }
}

/**
 * HealthStatus represents the health status of the runtime.
 */
class HealthStatus
{
    public string $status;
    public string $version;
    /** @var string[] */
    public array $nodes_loaded;

    public function __construct(string $version = '1.0.0', array $nodesLoaded = [])
    {
        $this->status = 'healthy';
        $this->version = $version;
        $this->nodes_loaded = $nodesLoaded;
    }

    public static function fromArray(array $data): self
    {
        $health = new self();
        $health->status = $data['status'] ?? 'healthy';
        $health->version = $data['version'] ?? '1.0.0';
        $health->nodes_loaded = $data['nodes_loaded'] ?? [];
        return $health;
    }

    public function toArray(): array
    {
        return [
            'status' => $this->status,
            'version' => $this->version,
            'nodes_loaded' => $this->nodes_loaded,
        ];
    }
}
