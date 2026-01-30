<?php

declare(strict_types=1);

namespace Blok\Blok\Examples;

use Blok\Blok\Errors\NodeException;
use Blok\Blok\Node\NodeHandler;
use Blok\Blok\Types\Context;

/**
 * TransformDataNode transforms JSON data based on field mappings.
 *
 * Config:
 *   - mappings (object, optional): Map of target field name to source field path (dot-notation)
 *   - include_only (array, optional): Only include these fields
 *   - exclude (array, optional): Exclude these fields
 *   - defaults (object, optional): Default values for missing fields
 */
final class TransformDataNode implements NodeHandler
{
    public function execute(Context $ctx, array $config): mixed
    {
        $body = $ctx->request->body;
        if (!is_array($body)) {
            throw NodeException::validation('request body must be a JSON object');
        }

        $result = [];

        // Apply field mappings if configured
        if (isset($config['mappings']) && is_array($config['mappings'])) {
            foreach ($config['mappings'] as $target => $sourcePath) {
                if (is_string($sourcePath)) {
                    $value = $this->getNestedValue($body, $sourcePath);
                    if ($value !== null) {
                        $result[$target] = $value;
                    }
                }
            }
        } else {
            // No mappings - copy all fields
            $result = $body;
        }

        // Apply include_only filter
        if (isset($config['include_only']) && is_array($config['include_only'])) {
            $allowed = array_filter($config['include_only'], 'is_string');
            $result = array_filter(
                $result,
                static fn (string $key): bool => in_array($key, $allowed, true),
                ARRAY_FILTER_USE_KEY,
            );
        }

        // Apply exclude filter
        if (isset($config['exclude']) && is_array($config['exclude'])) {
            foreach ($config['exclude'] as $field) {
                if (is_string($field)) {
                    unset($result[$field]);
                }
            }
        }

        // Apply defaults
        if (isset($config['defaults']) && is_array($config['defaults'])) {
            foreach ($config['defaults'] as $key => $value) {
                if (!array_key_exists($key, $result)) {
                    $result[$key] = $value;
                }
            }
        }

        // Store transformed data in context
        $ctx->setVar('transformed_data', $result);

        return $result;
    }

    /**
     * Get a nested value from an array using dot-notation path.
     */
    private function getNestedValue(array $data, string $path): mixed
    {
        $current = $data;
        foreach (explode('.', $path) as $part) {
            if (!is_array($current) || !array_key_exists($part, $current)) {
                return null;
            }
            $current = $current[$part];
        }
        return $current;
    }
}
