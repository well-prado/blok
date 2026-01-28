<?php

declare(strict_types=1);

namespace Blok;

use Psr\Http\Message\ServerRequestInterface;
use React\Http\HttpServer;
use React\Http\Message\Response as HttpResponse;
use React\Socket\SocketServer;

/**
 * Server is the HTTP server for the Blok PHP runtime.
 *
 * Provides two endpoints:
 *   POST /execute - Execute a registered node
 *   GET  /health  - Return runtime health status
 */
class Server
{
    private const VERSION = '1.0.0';

    private NodeRegistry $registry;
    private int $port;

    public function __construct(NodeRegistry $registry, ?int $port = null)
    {
        $this->registry = $registry;
        $this->port = $port ?? (int) (getenv('PORT') ?: 8080);
    }

    /**
     * Start the HTTP server and begin listening for requests.
     */
    public function start(): void
    {
        $server = new HttpServer(function (ServerRequestInterface $request) {
            return $this->handleRequest($request);
        });

        $socket = new SocketServer("0.0.0.0:{$this->port}");
        $server->listen($socket);

        echo "Blok PHP Runtime v" . self::VERSION . " starting on port {$this->port}" . PHP_EOL;
        echo "Registered nodes: " . $this->registry->size() . PHP_EOL;
    }

    /**
     * Route incoming requests to the appropriate handler.
     */
    private function handleRequest(ServerRequestInterface $request): HttpResponse
    {
        $path = $request->getUri()->getPath();
        $method = $request->getMethod();

        return match (true) {
            $path === '/execute' && $method === 'POST' => $this->handleExecute($request),
            $path === '/health' && $method === 'GET'   => $this->handleHealth(),
            $path === '/execute' && $method !== 'POST'  => $this->methodNotAllowed(),
            $path === '/health' && $method !== 'GET'    => $this->methodNotAllowed(),
            default                                     => $this->notFound(),
        };
    }

    /**
     * Handle POST /execute requests.
     */
    private function handleExecute(ServerRequestInterface $request): HttpResponse
    {
        try {
            $body = (string) $request->getBody();
            $data = json_decode($body, true, 512, JSON_THROW_ON_ERROR);

            $executionRequest = ExecutionRequest::fromArray($data);
            $result = $this->registry->execute($executionRequest);

            return $this->jsonResponse(200, $result->toArray());
        } catch (\JsonException $e) {
            $error = ExecutionResult::error('Invalid JSON request body: ' . $e->getMessage());
            return $this->jsonResponse(400, $error->toArray());
        } catch (\Throwable $e) {
            $error = ExecutionResult::errorWithDetails('Internal server error', [
                'message' => $e->getMessage(),
                'type' => get_class($e),
            ]);
            return $this->jsonResponse(500, $error->toArray());
        }
    }

    /**
     * Handle GET /health requests.
     */
    private function handleHealth(): HttpResponse
    {
        $health = $this->registry->getHealth(self::VERSION);
        return $this->jsonResponse(200, $health->toArray());
    }

    /**
     * Return a 405 Method Not Allowed response.
     */
    private function methodNotAllowed(): HttpResponse
    {
        return $this->jsonResponse(405, ['error' => 'Method not allowed']);
    }

    /**
     * Return a 404 Not Found response.
     */
    private function notFound(): HttpResponse
    {
        return $this->jsonResponse(404, ['error' => 'Not found']);
    }

    /**
     * Create a JSON HTTP response.
     */
    private function jsonResponse(int $status, array $data): HttpResponse
    {
        return new HttpResponse(
            $status,
            ['Content-Type' => 'application/json'],
            json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)
        );
    }
}
