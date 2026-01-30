<?php

declare(strict_types=1);

namespace Blok\Blok\Types;

/**
 * ExecutionResult is the response returned to the Blok runner.
 */
final class ExecutionResult
{
    public function __construct(
        public bool $success = false,
        public mixed $data = null,
        public mixed $errors = null,
        /** @var string[]|null */
        public ?array $logs = null,
        public ?ExecutionMetrics $metrics = null,
        /** @var array<string, mixed>|null */
        public ?array $vars = null,
    ) {}

    /**
     * Create a successful result.
     */
    public static function success(mixed $data): self
    {
        return new self(
            success: true,
            data: $data,
        );
    }

    /**
     * Create a successful result with metrics.
     */
    public static function successWithMetrics(mixed $data, ExecutionMetrics $metrics): self
    {
        return new self(
            success: true,
            data: $data,
            metrics: $metrics,
        );
    }

    /**
     * Create an error result.
     */
    public static function error(string $message): self
    {
        return new self(
            success: false,
            data: null,
            errors: ['message' => $message],
        );
    }

    /**
     * Create an error result with details.
     */
    public static function errorWithDetails(string $message, mixed $details): self
    {
        return new self(
            success: false,
            data: null,
            errors: [
                'message' => $message,
                'details' => $details,
            ],
        );
    }

    /**
     * Attach log entries to the result.
     */
    public function withLogs(array $logs): self
    {
        $this->logs = $logs;
        return $this;
    }

    /**
     * Attach metrics to the result.
     */
    public function withMetrics(ExecutionMetrics $metrics): self
    {
        $this->metrics = $metrics;
        return $this;
    }

    /**
     * Attach context variables to the result.
     *
     * @param array<string, mixed> $vars
     */
    public function withVars(array $vars): self
    {
        $this->vars = $vars;
        return $this;
    }

    /**
     * Create an ExecutionResult from an associative array.
     */
    public static function fromArray(array $data): self
    {
        return new self(
            success: $data['success'] ?? false,
            data: $data['data'] ?? null,
            errors: $data['errors'] ?? null,
            logs: $data['logs'] ?? null,
            metrics: isset($data['metrics']) ? ExecutionMetrics::fromArray($data['metrics']) : null,
            vars: $data['vars'] ?? null,
        );
    }

    /**
     * Convert to an associative array for JSON serialization.
     * Omits null optional fields.
     */
    public function toArray(): array
    {
        $result = [
            'success' => $this->success,
            'data' => $this->data,
        ];

        if ($this->errors !== null) {
            $result['errors'] = $this->errors;
        }
        if ($this->logs !== null) {
            $result['logs'] = $this->logs;
        }
        if ($this->metrics !== null) {
            $result['metrics'] = $this->metrics->toArray();
        }
        if ($this->vars !== null) {
            $result['vars'] = $this->vars;
        }

        return $result;
    }
}
