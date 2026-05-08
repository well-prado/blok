<?php

declare(strict_types=1);

namespace Blok\Blok\Server;

use Blok\Blok\Config\ServerConfig;
use Blok\Blok\Node\NodeRegistry;
use Blok\Blok\Types\ExecutionRequest;
use Psr\Http\Message\ServerRequestInterface;
use React\Http\HttpServer;
use React\Http\Message\Response as HttpResponse;
use React\Http\Middleware\RequestBodyBufferMiddleware;
use React\Http\Middleware\RequestBodyParserMiddleware;
use React\Http\Middleware\StreamingRequestMiddleware;
use React\Socket\SocketServer;

/**
 * Server is the HTTP server that handles /execute and /health endpoints
 * using ReactPHP for non-blocking I/O.
 */
final class Server
{
    private readonly ServerConfig $config;

    public function __construct(
        private readonly NodeRegistry $registry,
        ?ServerConfig $config = null,
    ) {
        $this->config = $config ?? ServerConfig::fromEnv();
    }

    /**
     * Start the HTTP server. This is a blocking call.
     */
    public function start(): void
    {
        // Explicit middleware chain with 16 MB body buffer.
        // Without this, ReactPHP's default 64 KB socket buffer silently truncates
        // large request bodies (common when ctx.vars accumulates data across steps).
        $server = new HttpServer(
            new StreamingRequestMiddleware(),
            new RequestBodyBufferMiddleware(16 * 1024 * 1024), // 16 MB
            new RequestBodyParserMiddleware(),
            function (ServerRequestInterface $request): HttpResponse {
                return $this->handleRequest($request);
            }
        );

        $address = sprintf('%s:%d', $this->config->host, $this->config->port);
        $socket = new SocketServer($address);
        $server->listen($socket);

        echo sprintf(
            "Blok blok runtime v%s listening on %s\n",
            $this->config->version,
            $address,
        );
    }

    /**
     * Handle an incoming HTTP request.
     */
    private function handleRequest(ServerRequestInterface $request): HttpResponse
    {
        $path = $request->getUri()->getPath();
        $method = strtoupper($request->getMethod());

        $headers = ['Content-Type' => 'application/json'];

        if ($this->config->enableCors) {
            $headers['Access-Control-Allow-Origin'] = '*';
            $headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
            $headers['Access-Control-Allow-Headers'] = 'Content-Type';
        }

        // Handle CORS preflight
        if ($method === 'OPTIONS' && $this->config->enableCors) {
            return new HttpResponse(204, $headers, '');
        }

        return match ($path) {
            '/execute' => $this->handleExecute($request, $method, $headers),
            '/health' => $this->handleHealth($method, $headers),
            default => $this->jsonResponse(404, ['error' => 'not found'], $headers),
        };
    }

    /**
     * Handle POST /execute.
     */
    private function handleExecute(
        ServerRequestInterface $request,
        string $method,
        array $headers,
    ): HttpResponse {
        if ($method !== 'POST') {
            return $this->jsonResponse(405, ['error' => 'method not allowed'], $headers);
        }

        $body = (string) $request->getBody();
        $expectedLength = (int) $request->getHeaderLine('Content-Length');
        $actualLength = strlen($body);

        // Detect Content-Length vs actual body mismatch (e.g. body truncated by buffer limit)
        if ($actualLength === 0 && $expectedLength > 0) {
            return $this->jsonResponse(400, [
                'success' => false,
                'data' => null,
                'errors' => [
                    'message' => sprintf(
                        'Empty body received (Content-Length: %d, actual: 0). '
                        . 'This usually means the request exceeded the body buffer limit.',
                        $expectedLength,
                    ),
                ],
            ], $headers);
        }

        $data = json_decode($body, true);

        if (json_last_error() !== JSON_ERROR_NONE || !is_array($data)) {
            return $this->jsonResponse(400, [
                'success' => false,
                'data' => null,
                'errors' => ['message' => 'invalid JSON: ' . json_last_error_msg()],
            ], $headers);
        }

        $execRequest = ExecutionRequest::fromArray($data);
        $result = $this->registry->execute($execRequest);

        return $this->jsonResponse(200, $result->toArray(), $headers);
    }

    /**
     * Handle GET /health.
     */
    private function handleHealth(string $method, array $headers): HttpResponse
    {
        if ($method !== 'GET') {
            return $this->jsonResponse(405, ['error' => 'method not allowed'], $headers);
        }

        $health = $this->registry->health();
        return $this->jsonResponse(200, $health->toArray(), $headers);
    }

    /**
     * Create a JSON HTTP response.
     */
    private function jsonResponse(int $status, array $data, array $headers): HttpResponse
    {
        $json = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        return new HttpResponse($status, $headers, $json ?: '{}');
    }
}
