<?php

declare(strict_types=1);

namespace Blok\Nanoservice\Tests\Node;

use Blok\Nanoservice\Node\NodeHandler;
use Blok\Nanoservice\Node\NodeRegistry;
use Blok\Nanoservice\Types\Context;
use Blok\Nanoservice\Types\ExecutionRequest;
use Blok\Nanoservice\Types\NodeConfig;
use Blok\Nanoservice\Testing\MockContext;
use PHPUnit\Framework\TestCase;

final class NodeRegistryTest extends TestCase
{
    private function createTestNode(mixed $returnValue): NodeHandler
    {
        return new class($returnValue) implements NodeHandler {
            public function __construct(private readonly mixed $data) {}

            public function execute(Context $ctx, array $config): mixed
            {
                return $this->data;
            }
        };
    }

    public function testRegisterAndGet(): void
    {
        $registry = new NodeRegistry('1.0.0');
        $node = $this->createTestNode(['msg' => 'hello']);

        $registry->register('test', $node);

        $this->assertNotNull($registry->get('test'));
        $this->assertNull($registry->get('missing'));
    }

    public function testNodeNames(): void
    {
        $registry = new NodeRegistry('1.0.0');
        $registry->register('alpha', $this->createTestNode(null));
        $registry->register('beta', $this->createTestNode(null));

        $names = $registry->nodeNames();
        $this->assertCount(2, $names);
        $this->assertContains('alpha', $names);
        $this->assertContains('beta', $names);
    }

    public function testCountAndIsEmpty(): void
    {
        $registry = new NodeRegistry('1.0.0');
        $this->assertTrue($registry->isEmpty());
        $this->assertSame(0, $registry->count());

        $registry->register('test', $this->createTestNode(null));
        $this->assertFalse($registry->isEmpty());
        $this->assertSame(1, $registry->count());
    }

    public function testExecuteSuccess(): void
    {
        $registry = new NodeRegistry('1.0.0');
        $registry->register('test', $this->createTestNode(['msg' => 'hello']));

        $req = new ExecutionRequest(
            node: new NodeConfig(name: 'test'),
            context: MockContext::create()->build(),
        );

        $result = $registry->execute($req);

        $this->assertTrue($result->success);
        $this->assertSame(['msg' => 'hello'], $result->data);
        $this->assertNotNull($result->metrics);
        $this->assertNotNull($result->metrics->durationMs);
        $this->assertGreaterThanOrEqual(0, $result->metrics->durationMs);
    }

    public function testExecuteNotFound(): void
    {
        $registry = new NodeRegistry('1.0.0');

        $req = new ExecutionRequest(
            node: new NodeConfig(name: 'missing'),
            context: MockContext::create()->build(),
        );

        $result = $registry->execute($req);

        $this->assertFalse($result->success);
        $this->assertNotNull($result->errors);
        $this->assertStringContainsString('not found', $result->errors['message']);
    }

    public function testExecuteHandlesException(): void
    {
        $failingNode = new class implements NodeHandler {
            public function execute(Context $ctx, array $config): mixed
            {
                throw new \RuntimeException('boom');
            }
        };

        $registry = new NodeRegistry('1.0.0');
        $registry->register('fail', $failingNode);

        $req = new ExecutionRequest(
            node: new NodeConfig(name: 'fail'),
            context: MockContext::create()->build(),
        );

        $result = $registry->execute($req);

        $this->assertFalse($result->success);
        $this->assertStringContainsString('boom', $result->errors['message']);
    }

    public function testHealth(): void
    {
        $registry = new NodeRegistry('2.0.0');
        $registry->register('a', $this->createTestNode(null));
        $registry->register('b', $this->createTestNode(null));

        $health = $registry->health();

        $this->assertSame('healthy', $health->status);
        $this->assertSame('2.0.0', $health->version);
        $this->assertCount(2, $health->nodesLoaded);
    }
}
