<?php

declare(strict_types=1);

namespace Blok\Blok\Examples;

use Blok\Blok\Node\TypedNode;
use Blok\Blok\Types\Context;

/** Typed input DTO for the typed-greet demo. */
final class TypedGreetInput
{
    public function __construct(public string $name, public int $repeat = 1)
    {
    }
}

/** Typed output DTO (declared so the output JSON Schema can be reflected). */
final class TypedGreetOutput
{
    public function __construct(public string $greeting, public int $length)
    {
    }
}

/** Typed greeting node demonstrating the SPEC-B TypedNode contract. */
final class TypedGreetNode extends TypedNode
{
    public function name(): string
    {
        return 'typed-greet';
    }

    public function description(): string
    {
        return 'Typed greeting (SPEC-B contract demo)';
    }

    protected function inputClass(): string
    {
        return TypedGreetInput::class;
    }

    protected function outputClass(): ?string
    {
        return TypedGreetOutput::class;
    }

    public function capabilityManifest(): ?array
    {
        return [
            'version' => '1',
            'classification' => 'agent-compatible',
            'effects' => [],
            'capabilities' => [],
            'secrets' => [],
            'determinism' => 'deterministic',
            'idempotency' => 'idempotent',
            'maturity' => 'stable',
            'resources' => [
                'maxDurationMs' => 5000,
                'maxInputBytes' => 4194304,
                'maxOutputBytes' => 4194304,
                'maxConcurrency' => 64,
            ],
        ];
    }

    protected function run(Context $ctx, object $input): mixed
    {
        /** @var TypedGreetInput $input */
        $repeat = $input->repeat > 0 ? $input->repeat : 1;
        $greeting = str_repeat('Hello, ' . $input->name, $repeat);

        return ['greeting' => $greeting, 'length' => strlen($greeting)];
    }
}
