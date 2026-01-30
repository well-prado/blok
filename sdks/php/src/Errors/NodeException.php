<?php

declare(strict_types=1);

namespace Blok\Blok\Errors;

/**
 * NodeException represents a structured error from node execution.
 *
 * Provides static factory methods for common error categories.
 */
final class NodeException extends \Exception
{
    public function __construct(
        string $message,
        private readonly int $errorCode,
        private readonly ErrorCategory $category,
        private readonly mixed $details = null,
        ?\Throwable $previous = null,
    ) {
        parent::__construct(
            sprintf('[%s] %s', $this->category->value, $message),
            $this->errorCode,
            $previous,
        );
    }

    /**
     * Get the error code.
     */
    public function getErrorCode(): int
    {
        return $this->errorCode;
    }

    /**
     * Get the error category.
     */
    public function getCategory(): ErrorCategory
    {
        return $this->category;
    }

    /**
     * Get the error details.
     */
    public function getDetails(): mixed
    {
        return $this->details;
    }

    /**
     * Create a validation error (400).
     */
    public static function validation(string $message, mixed $details = null): self
    {
        return new self($message, 400, ErrorCategory::Validation, $details);
    }

    /**
     * Create an execution error (500).
     */
    public static function execution(string $message, mixed $details = null): self
    {
        return new self($message, 500, ErrorCategory::Execution, $details);
    }

    /**
     * Create a configuration error (500).
     */
    public static function configuration(string $message, mixed $details = null): self
    {
        return new self($message, 500, ErrorCategory::Configuration, $details);
    }

    /**
     * Create a network error (502).
     */
    public static function network(string $message, mixed $details = null): self
    {
        return new self($message, 502, ErrorCategory::Network, $details);
    }

    /**
     * Create a not-found error (404).
     */
    public static function notFound(string $message, mixed $details = null): self
    {
        return new self($message, 404, ErrorCategory::NotFound, $details);
    }

    /**
     * Convert to a JSON-compatible array for ExecutionResult.errors.
     */
    public function toArray(): array
    {
        $result = [
            'message' => $this->getMessage(),
            'code' => $this->errorCode,
            'category' => $this->category->value,
        ];
        if ($this->details !== null) {
            $result['details'] = $this->details;
        }
        return $result;
    }
}
