<?php

declare(strict_types=1);

namespace Blok\Nanoservice\Types;

/**
 * Request represents the incoming HTTP request data within a workflow context.
 */
final class Request
{
    public function __construct(
        public mixed $body = null,
        /** @var array<string, string> */
        public array $headers = [],
        /** @var array<string, string> */
        public array $params = [],
        /** @var array<string, string> */
        public array $query = [],
        public string $method = '',
        public string $url = '',
        /** @var array<string, string> */
        public array $cookies = [],
        public string $baseUrl = '',
    ) {}

    /**
     * Get a field from the body as a string.
     */
    public function bodyStr(string $key): ?string
    {
        if (is_array($this->body) && isset($this->body[$key]) && is_string($this->body[$key])) {
            return $this->body[$key];
        }
        return null;
    }

    /**
     * Get a typed value from the body.
     */
    public function bodyGet(string $key, mixed $default = null): mixed
    {
        if (is_array($this->body) && array_key_exists($key, $this->body)) {
            return $this->body[$key];
        }
        return $default;
    }

    /**
     * Create a Request from an associative array.
     */
    public static function fromArray(array $data): self
    {
        return new self(
            body: $data['body'] ?? null,
            headers: $data['headers'] ?? [],
            params: $data['params'] ?? [],
            query: $data['query'] ?? [],
            method: $data['method'] ?? '',
            url: $data['url'] ?? '',
            cookies: $data['cookies'] ?? [],
            baseUrl: $data['baseUrl'] ?? '',
        );
    }

    /**
     * Convert to an associative array for JSON serialization.
     */
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
