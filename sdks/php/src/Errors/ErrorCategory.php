<?php

declare(strict_types=1);

namespace Blok\Nanoservice\Errors;

/**
 * ErrorCategory classifies the type of error that occurred.
 */
enum ErrorCategory: string
{
    case Validation = 'VALIDATION';
    case Execution = 'EXECUTION';
    case Configuration = 'CONFIGURATION';
    case Network = 'NETWORK';
    case NotFound = 'NOT_FOUND';
}
