<?php

declare(strict_types=1);

namespace Blok\Nanoservice\Tests\Validation;

use Blok\Nanoservice\Validation\SchemaValidator;
use PHPUnit\Framework\TestCase;

final class SchemaValidatorTest extends TestCase
{
    private SchemaValidator $validator;

    protected function setUp(): void
    {
        $this->validator = new SchemaValidator();
    }

    public function testTypeValidationString(): void
    {
        $this->assertEmpty($this->validator->validate('hello', ['type' => 'string']));
        $this->assertNotEmpty($this->validator->validate(42, ['type' => 'string']));
    }

    public function testTypeValidationNumber(): void
    {
        $this->assertEmpty($this->validator->validate(42, ['type' => 'number']));
        $this->assertEmpty($this->validator->validate(3.14, ['type' => 'number']));
        $this->assertNotEmpty($this->validator->validate('hello', ['type' => 'number']));
    }

    public function testTypeValidationInteger(): void
    {
        $this->assertEmpty($this->validator->validate(42, ['type' => 'integer']));
        $this->assertNotEmpty($this->validator->validate(3.14, ['type' => 'integer']));
        $this->assertNotEmpty($this->validator->validate('hello', ['type' => 'integer']));
    }

    public function testTypeValidationBoolean(): void
    {
        $this->assertEmpty($this->validator->validate(true, ['type' => 'boolean']));
        $this->assertEmpty($this->validator->validate(false, ['type' => 'boolean']));
        $this->assertNotEmpty($this->validator->validate(1, ['type' => 'boolean']));
    }

    public function testTypeValidationObject(): void
    {
        $this->assertEmpty($this->validator->validate(['key' => 'value'], ['type' => 'object']));
        $this->assertNotEmpty($this->validator->validate('hello', ['type' => 'object']));
    }

    public function testTypeValidationArray(): void
    {
        $this->assertEmpty($this->validator->validate([1, 2, 3], ['type' => 'array']));
        $this->assertEmpty($this->validator->validate([], ['type' => 'array']));
        $this->assertNotEmpty($this->validator->validate('hello', ['type' => 'array']));
    }

    public function testTypeValidationNull(): void
    {
        $this->assertEmpty($this->validator->validate(null, ['type' => 'null']));
        $this->assertNotEmpty($this->validator->validate('hello', ['type' => 'null']));
    }

    public function testRequiredFields(): void
    {
        $schema = [
            'type' => 'object',
            'required' => ['name', 'email'],
        ];

        $valid = ['name' => 'John', 'email' => 'john@example.com'];
        $this->assertEmpty($this->validator->validate($valid, $schema));

        $missing = ['name' => 'John'];
        $errors = $this->validator->validate($missing, $schema);
        $this->assertCount(1, $errors);
        $this->assertStringContainsString('email', $errors[0]);
    }

    public function testRequiredFieldsAllMissing(): void
    {
        $schema = [
            'type' => 'object',
            'required' => ['a', 'b', 'c'],
        ];

        $errors = $this->validator->validate([], $schema);
        $this->assertCount(3, $errors);
    }

    public function testStringConstraints(): void
    {
        $schema = ['type' => 'string', 'minLength' => 2, 'maxLength' => 10];

        $this->assertEmpty($this->validator->validate('hello', $schema));
        $this->assertNotEmpty($this->validator->validate('x', $schema));
        $this->assertNotEmpty($this->validator->validate('this is way too long', $schema));
    }

    public function testNumericConstraints(): void
    {
        $schema = ['type' => 'number', 'minimum' => 0, 'maximum' => 100];

        $this->assertEmpty($this->validator->validate(50, $schema));
        $this->assertNotEmpty($this->validator->validate(-1, $schema));
        $this->assertNotEmpty($this->validator->validate(101, $schema));
    }

    public function testEnumValidation(): void
    {
        $schema = ['type' => 'string', 'enum' => ['red', 'green', 'blue']];

        $this->assertEmpty($this->validator->validate('red', $schema));
        $this->assertNotEmpty($this->validator->validate('yellow', $schema));
    }

    public function testNestedObjectValidation(): void
    {
        $schema = [
            'type' => 'object',
            'properties' => [
                'user' => [
                    'type' => 'object',
                    'required' => ['name'],
                    'properties' => [
                        'name' => ['type' => 'string'],
                    ],
                ],
            ],
        ];

        $valid = ['user' => ['name' => 'John']];
        $this->assertEmpty($this->validator->validate($valid, $schema));

        $invalid = ['user' => []];
        $errors = $this->validator->validate($invalid, $schema);
        $this->assertCount(1, $errors);
        $this->assertStringContainsString('name', $errors[0]);
    }

    public function testArrayItemsValidation(): void
    {
        $schema = [
            'type' => 'array',
            'items' => ['type' => 'string'],
        ];

        $this->assertEmpty($this->validator->validate(['a', 'b', 'c'], $schema));
        $this->assertNotEmpty($this->validator->validate(['a', 42, 'c'], $schema));
    }

    public function testArrayConstraints(): void
    {
        $schema = [
            'type' => 'array',
            'minItems' => 2,
            'maxItems' => 5,
        ];

        $this->assertEmpty($this->validator->validate([1, 2, 3], $schema));
        $this->assertNotEmpty($this->validator->validate([1], $schema));
        $this->assertNotEmpty($this->validator->validate([1, 2, 3, 4, 5, 6], $schema));
    }

    public function testPropertyTypeValidation(): void
    {
        $schema = [
            'type' => 'object',
            'properties' => [
                'name' => ['type' => 'string'],
                'age' => ['type' => 'integer'],
            ],
        ];

        $valid = ['name' => 'John', 'age' => 30];
        $this->assertEmpty($this->validator->validate($valid, $schema));

        $invalid = ['name' => 'John', 'age' => 'thirty'];
        $errors = $this->validator->validate($invalid, $schema);
        $this->assertCount(1, $errors);
        $this->assertStringContainsString('age', $errors[0]);
    }

    public function testEmptySchemaAcceptsAnything(): void
    {
        $this->assertEmpty($this->validator->validate('hello', []));
        $this->assertEmpty($this->validator->validate(42, []));
        $this->assertEmpty($this->validator->validate(null, []));
    }
}
