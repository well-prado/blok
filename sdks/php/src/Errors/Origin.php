<?php

declare(strict_types=1);

namespace Blok\Blok\Errors;

/**
 * Carrier of the auto-enrichment fields the gRPC servicer fills into a
 * handler-thrown {@see BlokError} when the handler didn't set those fields
 * explicitly.
 */
final class Origin
{
    public function __construct(
        public readonly string $node,
        public readonly string $sdk,
        public readonly string $sdkVersion,
        public readonly string $runtimeKind,
    ) {}

    /**
     * Build an {@see Origin} populated with the SDK constants
     * ({@see BlokError::DEFAULT_SDK_NAME}, {@see BlokError::DEFAULT_RUNTIME_KIND})
     * and the caller-provided node name + SDK version.
     */
    public static function defaults(string $node, string $sdkVersion): self
    {
        return new self(
            node: $node,
            sdk: BlokError::DEFAULT_SDK_NAME,
            sdkVersion: $sdkVersion,
            runtimeKind: BlokError::DEFAULT_RUNTIME_KIND,
        );
    }
}
