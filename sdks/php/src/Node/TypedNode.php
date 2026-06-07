<?php

declare(strict_types=1);

namespace Blok\Blok\Node;

use Blok\Blok\Errors\BlokError;
use Blok\Blok\Types\Context;

/**
 * Typed node base (SPEC-B P4) — the PHP equivalent of the TypeScript
 * `defineNode` / Python `@node` / Rust `TypedNode`. Declare a typed input DTO
 * (a class with constructor-promoted typed properties) via {@see inputClass};
 * the SDK hydrates the raw config array into it (a type mismatch / missing
 * required field → structured {@see BlokError}, HTTP 400) BEFORE {@see run},
 * and reflects the input/output JSON Schemas — instead of a raw `array $config`.
 *
 * Register like any handler: `$registry->register('@acme/search', new SearchNode());`
 *
 * ```php
 * final class SearchInput {
 *     public function __construct(public string $query, public int $limit = 10) {}
 * }
 * final class SearchNode extends TypedNode {
 *     public function name(): string { return '@acme/search'; }
 *     public function description(): string { return 'Full-text search'; }
 *     protected function inputClass(): string { return SearchInput::class; }
 *     protected function run(Context $ctx, object $input): mixed {
 *         $rows = array_fill(0, $input->limit, $input->query);
 *         return ['results' => $rows, 'count' => count($rows)];
 *     }
 * }
 * ```
 */
abstract class TypedNode implements NodeHandler, NodeReflector
{
    /** The node's registered name (e.g. `"@acme/search"`). */
    abstract public function name(): string;

    /** Human-readable description, surfaced in the node catalog. */
    public function description(): string
    {
        return '';
    }

    /** @return class-string FQCN of the input DTO. */
    abstract protected function inputClass(): string;

    /** @return class-string|null FQCN of the output DTO (for schema reflection), or null. */
    protected function outputClass(): ?string
    {
        return null;
    }

    /**
     * Run the node with a VALIDATED, hydrated input DTO.
     *
     * @param object $input instance of {@see inputClass}
     * @return mixed the output (array/scalar/object) included in the result
     */
    abstract protected function run(Context $ctx, object $input): mixed;

    public function execute(Context $ctx, array $config): mixed
    {
        try {
            $input = $this->hydrate($this->inputClass(), $config);
        } catch (\Throwable $e) {
            throw BlokError::validation()
                ->code('NODE_INPUT_VALIDATION')
                ->message(sprintf("Input validation failed for node '%s': %s", $this->name(), $e->getMessage()))
                ->httpStatus(400)
                ->node($this->name())
                ->build();
        }

        return $this->run($ctx, $input);
    }

    /** Hydrate a config array into the typed DTO; the typed ctor enforces types. */
    private function hydrate(string $class, array $config): object
    {
        $ref = new \ReflectionClass($class);
        $ctor = $ref->getConstructor();
        if ($ctor === null) {
            return $ref->newInstance();
        }

        $args = [];
        foreach ($ctor->getParameters() as $param) {
            $name = $param->getName();
            if (array_key_exists($name, $config)) {
                $args[] = $config[$name];
            } elseif ($param->isDefaultValueAvailable()) {
                $args[] = $param->getDefaultValue();
            } elseif ($param->allowsNull()) {
                $args[] = null;
            } else {
                throw new \InvalidArgumentException("missing required field '{$name}'");
            }
        }

        // A typed constructor throws TypeError on an unconvertible value.
        return $ref->newInstanceArgs($args);
    }

    public function inputSchema(): ?array
    {
        return $this->reflectSchema($this->inputClass());
    }

    public function outputSchema(): ?array
    {
        $class = $this->outputClass();

        return $class === null ? null : $this->reflectSchema($class);
    }

    /** @return array<string, mixed> a minimal JSON Schema from the DTO's typed ctor params. */
    private function reflectSchema(string $class): array
    {
        $ref = new \ReflectionClass($class);
        $properties = [];
        $required = [];

        $ctor = $ref->getConstructor();
        if ($ctor !== null) {
            foreach ($ctor->getParameters() as $param) {
                $properties[$param->getName()] = $this->typeToSchema($param->getType());
                if (!$param->isOptional() && !$param->allowsNull()) {
                    $required[] = $param->getName();
                }
            }
        }

        $schema = ['type' => 'object', 'properties' => (object) $properties];
        if ($required !== []) {
            $schema['required'] = $required;
        }

        return $schema;
    }

    /** @return array<string, mixed> */
    private function typeToSchema(?\ReflectionType $type): array
    {
        if ($type instanceof \ReflectionNamedType) {
            return match ($type->getName()) {
                'int' => ['type' => 'integer'],
                'float' => ['type' => 'number'],
                'bool' => ['type' => 'boolean'],
                'string' => ['type' => 'string'],
                'array' => ['type' => 'array'],
                default => ['type' => 'object'],
            };
        }

        return [];
    }
}
