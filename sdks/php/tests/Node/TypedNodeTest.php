<?php

declare(strict_types=1);

namespace Blok\Blok\Tests\Node;

use Blok\Blok\Errors\BlokError;
use Blok\Blok\Node\NodeReflector;
use Blok\Blok\Node\TypedNode;
use Blok\Blok\Types\Context;
use PHPUnit\Framework\TestCase;

final class SearchInput
{
    public function __construct(public string $query, public int $limit = 10)
    {
    }
}

final class SearchNode extends TypedNode
{
    public function name(): string
    {
        return '@acme/search';
    }

    public function description(): string
    {
        return 'Full-text search';
    }

    protected function inputClass(): string
    {
        return SearchInput::class;
    }

    protected function run(Context $ctx, object $input): mixed
    {
        /** @var SearchInput $input */
        $rows = array_fill(0, $input->limit, $input->query);

        return ['results' => $rows, 'count' => count($rows)];
    }
}

final class TypedNodeTest extends TestCase
{
    public function testValidatesInputAndRuns(): void
    {
        $out = (new SearchNode())->execute(new Context(), ['query' => 'ada', 'limit' => 2]);
        $this->assertSame(2, $out['count']);
        $this->assertSame(['ada', 'ada'], $out['results']);
    }

    public function testAppliesDefaultValues(): void
    {
        $out = (new SearchNode())->execute(new Context(), ['query' => 'x']);
        $this->assertSame(10, $out['count']);
    }

    public function testMissingRequiredFieldThrowsStructuredBlokError(): void
    {
        try {
            (new SearchNode())->execute(new Context(), ['limit' => 3]); // missing 'query'
            $this->fail('expected a BlokError');
        } catch (BlokError $e) {
            $this->assertSame(400, $e->httpStatus);
            $this->assertSame('NODE_INPUT_VALIDATION', $e->errorCode);
        }
    }

    public function testReflectsSchemasAndDescription(): void
    {
        $node = new SearchNode();
        $this->assertInstanceOf(NodeReflector::class, $node);
        $this->assertSame('Full-text search', $node->description());

        $schema = $node->inputSchema();
        $this->assertSame('object', $schema['type']);
        $props = (array) $schema['properties'];
        $this->assertArrayHasKey('query', $props);
        $this->assertSame(['query'], $schema['required']);
    }
}
