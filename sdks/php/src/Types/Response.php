<?php

declare(strict_types=1);

namespace Blok\Nanoservice\Types;

/**
 * Response represents the workflow response.
 */
final class Response
{
    public function __construct(
        public mixed $data = null,
        public string $contentType = '',
        public bool $success = false,
        public mixed $error = null,
    ) {}

    /**
     * Create a Response from an associative array.
     */
    public static function fromArray(array $data): self
    {
        return new self(
            data: $data['data'] ?? null,
            contentType: $data['contentType'] ?? '',
            success: $data['success'] ?? false,
            error: $data['error'] ?? null,
        );
    }

    /**
     * Convert to an associative array for JSON serialization.
     */
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
