<?php

declare(strict_types=1);

namespace Blok\Blok\Server;

/**
 * Raised by codec helpers when a proto envelope contains malformed JSON in
 * one of the bytes-encoded fields (`inputs`, `previous_output`, `vars`).
 *
 * Mapped to gRPC INVALID_ARGUMENT (HTTP 400) at the service boundary.
 */
final class DecodeException extends \RuntimeException {}
