<?php

declare(strict_types=1);

namespace Blok\Nanoservice\Validation;

/**
 * SchemaValidator validates data against a JSON Schema (Draft 7 subset).
 *
 * Supports: type, required, properties, enum, minLength, maxLength,
 * minimum, maximum, items, minItems, maxItems.
 */
final class SchemaValidator
{
    /**
     * Validate data against a schema. Returns a list of error messages.
     *
     * @param mixed $data The data to validate
     * @param array<string, mixed> $schema The JSON Schema to validate against
     * @return string[] List of validation error messages (empty if valid)
     */
    public function validate(mixed $data, array $schema): array
    {
        $errors = [];
        $this->validateValue($data, $schema, '$', $errors);
        return $errors;
    }

    /**
     * Recursively validate a value against a schema.
     */
    private function validateValue(mixed $data, array $schema, string $path, array &$errors): void
    {
        // Type check
        if (isset($schema['type']) && is_string($schema['type'])) {
            if (!$this->checkType($data, $schema['type'])) {
                $errors[] = sprintf(
                    '%s: expected type "%s", got %s',
                    $path,
                    $schema['type'],
                    $this->typeName($data),
                );
                return;
            }
        }

        // Enum check
        if (isset($schema['enum']) && is_array($schema['enum'])) {
            if (!in_array($data, $schema['enum'], true)) {
                $errors[] = sprintf('%s: value not in allowed enum values', $path);
            }
        }

        // Object: required fields
        if (isset($schema['required']) && is_array($schema['required']) && is_array($data)) {
            foreach ($schema['required'] as $field) {
                if (is_string($field) && !array_key_exists($field, $data)) {
                    $errors[] = sprintf('%s: missing required field "%s"', $path, $field);
                }
            }
        }

        // Object: properties
        if (isset($schema['properties']) && is_array($schema['properties']) && is_array($data)) {
            foreach ($schema['properties'] as $propName => $propSchema) {
                if (array_key_exists($propName, $data) && is_array($propSchema)) {
                    $propPath = sprintf('%s.%s', $path, $propName);
                    $this->validateValue($data[$propName], $propSchema, $propPath, $errors);
                }
            }
        }

        // String constraints
        if (is_string($data)) {
            if (isset($schema['minLength']) && is_int($schema['minLength'])) {
                if (mb_strlen($data) < $schema['minLength']) {
                    $errors[] = sprintf(
                        '%s: string length %d is less than minimum %d',
                        $path,
                        mb_strlen($data),
                        $schema['minLength'],
                    );
                }
            }
            if (isset($schema['maxLength']) && is_int($schema['maxLength'])) {
                if (mb_strlen($data) > $schema['maxLength']) {
                    $errors[] = sprintf(
                        '%s: string length %d exceeds maximum %d',
                        $path,
                        mb_strlen($data),
                        $schema['maxLength'],
                    );
                }
            }
        }

        // Numeric constraints
        if (is_int($data) || is_float($data)) {
            if (isset($schema['minimum']) && is_numeric($schema['minimum'])) {
                if ($data < $schema['minimum']) {
                    $errors[] = sprintf(
                        '%s: value %s is less than minimum %s',
                        $path,
                        (string) $data,
                        (string) $schema['minimum'],
                    );
                }
            }
            if (isset($schema['maximum']) && is_numeric($schema['maximum'])) {
                if ($data > $schema['maximum']) {
                    $errors[] = sprintf(
                        '%s: value %s exceeds maximum %s',
                        $path,
                        (string) $data,
                        (string) $schema['maximum'],
                    );
                }
            }
        }

        // Array items
        if (isset($schema['items']) && is_array($schema['items']) && is_array($data) && array_is_list($data)) {
            foreach ($data as $i => $item) {
                $itemPath = sprintf('%s[%d]', $path, $i);
                $this->validateValue($item, $schema['items'], $itemPath, $errors);
            }
        }

        // Array constraints
        if (is_array($data) && array_is_list($data)) {
            if (isset($schema['minItems']) && is_int($schema['minItems'])) {
                if (count($data) < $schema['minItems']) {
                    $errors[] = sprintf(
                        '%s: array length %d is less than minimum %d',
                        $path,
                        count($data),
                        $schema['minItems'],
                    );
                }
            }
            if (isset($schema['maxItems']) && is_int($schema['maxItems'])) {
                if (count($data) > $schema['maxItems']) {
                    $errors[] = sprintf(
                        '%s: array length %d exceeds maximum %d',
                        $path,
                        count($data),
                        $schema['maxItems'],
                    );
                }
            }
        }
    }

    /**
     * Check if a value matches the expected JSON Schema type.
     *
     * Note: In PHP, empty arrays ([]) are ambiguous - they could represent
     * either an empty JSON object {} or an empty JSON array [].
     * We treat empty arrays as valid for both "object" and "array" types.
     */
    private function checkType(mixed $data, string $expected): bool
    {
        return match ($expected) {
            'string' => is_string($data),
            'number' => is_int($data) || is_float($data),
            'integer' => is_int($data),
            'boolean' => is_bool($data),
            'object' => is_array($data) && (empty($data) || !array_is_list($data)),
            'array' => is_array($data) && (empty($data) || array_is_list($data)),
            'null' => $data === null,
            default => true,
        };
    }

    /**
     * Get the JSON Schema type name for a PHP value.
     */
    private function typeName(mixed $data): string
    {
        if ($data === null) {
            return 'null';
        }
        if (is_bool($data)) {
            return 'boolean';
        }
        if (is_int($data) || is_float($data)) {
            return 'number';
        }
        if (is_string($data)) {
            return 'string';
        }
        if (is_array($data)) {
            return array_is_list($data) ? 'array' : 'object';
        }
        return 'unknown';
    }
}
