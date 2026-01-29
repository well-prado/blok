<?php

declare(strict_types=1);

namespace Blok\Nanoservice\Tests\Types;

use Blok\Nanoservice\Types\ExecutionMetrics;
use Blok\Nanoservice\Types\ExecutionResult;
use PHPUnit\Framework\TestCase;

final class ExecutionResultTest extends TestCase
{
    public function testSuccessFactory(): void
    {
        $result = ExecutionResult::success(['message' => 'hi']);

        $this->assertTrue($result->success);
        $this->assertSame(['message' => 'hi'], $result->data);
        $this->assertNull($result->errors);
        $this->assertNull($result->logs);
        $this->assertNull($result->metrics);
    }

    public function testSuccessWithMetricsFactory(): void
    {
        $metrics = new ExecutionMetrics(durationMs: 12.5);
        $result = ExecutionResult::successWithMetrics(['data' => true], $metrics);

        $this->assertTrue($result->success);
        $this->assertSame(['data' => true], $result->data);
        $this->assertNotNull($result->metrics);
        $this->assertSame(12.5, $result->metrics->durationMs);
    }

    public function testErrorFactory(): void
    {
        $result = ExecutionResult::error('something broke');

        $this->assertFalse($result->success);
        $this->assertNull($result->data);
        $this->assertNotNull($result->errors);
        $this->assertSame('something broke', $result->errors['message']);
    }

    public function testErrorWithDetailsFactory(): void
    {
        $result = ExecutionResult::errorWithDetails('bad input', ['field' => 'name']);

        $this->assertFalse($result->success);
        $this->assertSame('bad input', $result->errors['message']);
        $this->assertSame(['field' => 'name'], $result->errors['details']);
    }

    public function testWithLogs(): void
    {
        $result = ExecutionResult::success(['ok' => true]);
        $result->withLogs(['log line 1', 'log line 2']);

        $this->assertNotNull($result->logs);
        $this->assertCount(2, $result->logs);
        $this->assertSame('log line 1', $result->logs[0]);
    }

    public function testWithMetrics(): void
    {
        $result = ExecutionResult::success(['ok' => true]);
        $metrics = new ExecutionMetrics(durationMs: 5.0, memoryBytes: 1024);
        $result->withMetrics($metrics);

        $this->assertNotNull($result->metrics);
        $this->assertSame(5.0, $result->metrics->durationMs);
        $this->assertSame(1024, $result->metrics->memoryBytes);
    }

    public function testToArraySuccess(): void
    {
        $result = ExecutionResult::success(['message' => 'hello']);
        $array = $result->toArray();

        $this->assertTrue($array['success']);
        $this->assertSame(['message' => 'hello'], $array['data']);
        $this->assertArrayNotHasKey('errors', $array);
        $this->assertArrayNotHasKey('logs', $array);
        $this->assertArrayNotHasKey('metrics', $array);
    }

    public function testToArrayError(): void
    {
        $result = ExecutionResult::error('failed');
        $array = $result->toArray();

        $this->assertFalse($array['success']);
        $this->assertNull($array['data']);
        $this->assertArrayHasKey('errors', $array);
        $this->assertSame('failed', $array['errors']['message']);
    }

    public function testToArrayWithMetrics(): void
    {
        $metrics = new ExecutionMetrics(durationMs: 10.0);
        $result = ExecutionResult::successWithMetrics(['done' => true], $metrics);
        $array = $result->toArray();

        $this->assertArrayHasKey('metrics', $array);
        $this->assertSame(10.0, $array['metrics']['duration_ms']);
    }

    public function testFromArray(): void
    {
        $data = [
            'success' => true,
            'data' => ['key' => 'value'],
            'errors' => null,
            'logs' => ['line1'],
            'metrics' => ['duration_ms' => 3.14],
        ];

        $result = ExecutionResult::fromArray($data);

        $this->assertTrue($result->success);
        $this->assertSame(['key' => 'value'], $result->data);
        $this->assertSame(['line1'], $result->logs);
        $this->assertNotNull($result->metrics);
        $this->assertSame(3.14, $result->metrics->durationMs);
    }

    public function testMetricsOmitsNullValues(): void
    {
        $metrics = new ExecutionMetrics(durationMs: 5.0);
        $array = $metrics->toArray();

        $this->assertArrayHasKey('duration_ms', $array);
        $this->assertArrayNotHasKey('cpu_ms', $array);
        $this->assertArrayNotHasKey('memory_bytes', $array);
    }
}
