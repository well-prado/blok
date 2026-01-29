<?php

declare(strict_types=1);

namespace Blok\Nanoservice\Tests\Logging;

use Blok\Nanoservice\Logging\LogEntry;
use Blok\Nanoservice\Logging\Logger;
use Blok\Nanoservice\Logging\LogLevel;
use PHPUnit\Framework\TestCase;

final class LoggerTest extends TestCase
{
    public function testLevelFiltering(): void
    {
        $logger = new Logger(LogLevel::Info);
        $logger->debug('hidden');
        $logger->info('visible');
        $logger->warn('visible');
        $logger->error('visible');

        $this->assertCount(3, $logger->entries());
    }

    public function testDebugLevelShowsAll(): void
    {
        $logger = new Logger(LogLevel::Debug);
        $logger->debug('visible');
        $logger->info('visible');
        $logger->warn('visible');
        $logger->error('visible');

        $this->assertCount(4, $logger->entries());
    }

    public function testErrorLevelShowsOnlyErrors(): void
    {
        $logger = new Logger(LogLevel::Error);
        $logger->debug('hidden');
        $logger->info('hidden');
        $logger->warn('hidden');
        $logger->error('visible');

        $this->assertCount(1, $logger->entries());
        $this->assertSame(LogLevel::Error, $logger->entries()[0]->level);
    }

    public function testLogWithFields(): void
    {
        $logger = new Logger(LogLevel::Debug);
        $logger->infoWith('test', ['key' => 'value']);

        $entries = $logger->entries();
        $this->assertCount(1, $entries);
        $this->assertNotNull($entries[0]->fields);
        $this->assertSame('value', $entries[0]->fields['key']);
    }

    public function testAllLogMethods(): void
    {
        $logger = new Logger(LogLevel::Debug);

        $logger->debug('debug msg');
        $logger->debugWith('debug fields', ['a' => 1]);
        $logger->info('info msg');
        $logger->infoWith('info fields', ['b' => 2]);
        $logger->warn('warn msg');
        $logger->warnWith('warn fields', ['c' => 3]);
        $logger->error('error msg');
        $logger->errorWith('error fields', ['d' => 4]);

        $this->assertCount(8, $logger->entries());
    }

    public function testLines(): void
    {
        $logger = new Logger(LogLevel::Debug);
        $logger->info('hello');
        $logger->error('oops');

        $lines = $logger->lines();
        $this->assertCount(2, $lines);
        $this->assertStringContainsString('[INFO]', $lines[0]);
        $this->assertStringContainsString('hello', $lines[0]);
        $this->assertStringContainsString('[ERROR]', $lines[1]);
        $this->assertStringContainsString('oops', $lines[1]);
    }

    public function testLinesWithFields(): void
    {
        $logger = new Logger(LogLevel::Debug);
        $logger->infoWith('request', ['method' => 'POST']);

        $lines = $logger->lines();
        $this->assertCount(1, $lines);
        $this->assertStringContainsString('POST', $lines[0]);
    }

    public function testClear(): void
    {
        $logger = new Logger(LogLevel::Debug);
        $logger->info('test');
        $this->assertCount(1, $logger->entries());

        $logger->clear();
        $this->assertCount(0, $logger->entries());
    }

    public function testEntryTimestampFormat(): void
    {
        $logger = new Logger(LogLevel::Debug);
        $logger->info('test');

        $entry = $logger->entries()[0];
        // Should be ISO 8601 format
        $this->assertMatchesRegularExpression(
            '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/',
            $entry->timestamp,
        );
    }

    public function testLogEntryToString(): void
    {
        $entry = new LogEntry(
            level: LogLevel::Info,
            message: 'test message',
            timestamp: '2024-01-01T00:00:00Z',
        );

        $this->assertSame('[INFO] 2024-01-01T00:00:00Z test message', (string) $entry);
    }

    public function testLogEntryToStringWithFields(): void
    {
        $entry = new LogEntry(
            level: LogLevel::Error,
            message: 'failed',
            timestamp: '2024-01-01T00:00:00Z',
            fields: ['code' => 500],
        );

        $str = (string) $entry;
        $this->assertStringContainsString('[ERROR]', $str);
        $this->assertStringContainsString('failed', $str);
        $this->assertStringContainsString('500', $str);
    }

    public function testLogLevelPriority(): void
    {
        // assertLessThan($expected, $actual) asserts $actual < $expected
        $this->assertLessThan(LogLevel::Info->priority(), LogLevel::Debug->priority());
        $this->assertLessThan(LogLevel::Warn->priority(), LogLevel::Info->priority());
        $this->assertLessThan(LogLevel::Error->priority(), LogLevel::Warn->priority());
    }

    public function testLogLevelFromString(): void
    {
        $this->assertSame(LogLevel::Debug, LogLevel::fromString('DEBUG'));
        $this->assertSame(LogLevel::Info, LogLevel::fromString('INFO'));
        $this->assertSame(LogLevel::Warn, LogLevel::fromString('WARN'));
        $this->assertSame(LogLevel::Warn, LogLevel::fromString('WARNING'));
        $this->assertSame(LogLevel::Error, LogLevel::fromString('ERROR'));
        $this->assertSame(LogLevel::Info, LogLevel::fromString('UNKNOWN'));
    }
}
