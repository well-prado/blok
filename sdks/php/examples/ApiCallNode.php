<?php

declare(strict_types=1);

namespace Blok\Blok\Examples;

use Blok\Blok\Errors\NodeException;
use Blok\Blok\Node\NodeHandler;
use Blok\Blok\Types\Context;

/**
 * ApiCallNode makes HTTP requests to external APIs.
 *
 * Config:
 *   - url (string, required): The URL to call
 *   - method (string, optional): HTTP method (default: GET)
 *   - timeout (int, optional): Timeout in seconds (default: 10)
 *   - headers (object, optional): Additional headers to send
 *
 * Body (for POST/PUT/PATCH):
 *   - body (mixed, optional): Request body to send
 */
final class ApiCallNode implements NodeHandler
{
    public function execute(Context $ctx, array $config): mixed
    {
        $url = $config['url'] ?? null;
        if (!is_string($url) || $url === '') {
            throw NodeException::configuration("'url' is required in node config");
        }

        $method = strtoupper((string) ($config['method'] ?? 'GET'));
        $timeout = (int) ($config['timeout'] ?? 10);

        // Build HTTP context options
        $httpOptions = [
            'method' => $method,
            'timeout' => $timeout,
            'ignore_errors' => true,
            'header' => "Content-Type: application/json\r\n",
        ];

        // Add custom headers from config
        if (isset($config['headers']) && is_array($config['headers'])) {
            foreach ($config['headers'] as $key => $value) {
                if (is_string($value)) {
                    $httpOptions['header'] .= sprintf("%s: %s\r\n", $key, $value);
                }
            }
        }

        // Add body for POST/PUT/PATCH
        if (in_array($method, ['POST', 'PUT', 'PATCH'], true)) {
            $body = is_array($ctx->request->body) ? ($ctx->request->body['body'] ?? null) : null;
            if ($body !== null) {
                $httpOptions['content'] = json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            }
        }

        $streamContext = stream_context_create([
            'http' => $httpOptions,
            'ssl' => [
                'verify_peer' => true,
                'verify_peer_name' => true,
            ],
        ]);

        $responseBody = @file_get_contents($url, false, $streamContext);

        if ($responseBody === false) {
            throw NodeException::network(sprintf('request to %s failed', $url));
        }

        // Parse status code from response headers
        $statusCode = 200;
        $responseHeaders = [];
        if (isset($http_response_header) && is_array($http_response_header)) {
            foreach ($http_response_header as $header) {
                if (preg_match('/^HTTP\/[\d.]+ (\d{3})/', $header, $matches)) {
                    $statusCode = (int) $matches[1];
                } else {
                    $parts = explode(':', $header, 2);
                    if (count($parts) === 2) {
                        $responseHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
                    }
                }
            }
        }

        // Try to parse response as JSON, fall back to string
        $data = json_decode($responseBody, true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            $data = $responseBody;
        }

        return [
            'status' => $statusCode,
            'data' => $data,
            'headers' => $responseHeaders,
        ];
    }
}
