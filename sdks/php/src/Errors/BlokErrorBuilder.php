<?php

declare(strict_types=1);

namespace Blok\Blok\Errors;

use Throwable;

/**
 * Fluent builder per master plan §17.5. Each setter returns `$this` so chained
 * calls compose without intermediate variables. Call {@see self::build()} to
 * finalize into a {@see BlokError}.
 *
 * Companion class to {@see BlokError}; lives in its own file for autoload
 * clarity. The legacy `Builder` inner-class pattern is unidiomatic in PHP
 * (each class is its own file under PSR-4); this companion form mirrors how
 * `Spiral\GRPC\Server` and other modern PHP libraries structure builders.
 */
final class BlokErrorBuilder
{
    private BlokErrorCategory $category;
    private BlokErrorSeverity $severity = BlokErrorSeverity::Error;
    private string $code = '';
    private string $message = '';
    private string $description = '';
    private string $remediation = '';
    private string $docUrl = '';
    private int $httpStatus;
    private bool $retryable;
    private int $retryAfterMs = 0;
    private mixed $details = null;
    private mixed $contextSnapshot = null;
    private ?Throwable $cause = null;
    private string $node = '';
    private string $sdk = '';
    private string $sdkVersion = '';
    private string $runtimeKind = '';
    private ?\DateTimeImmutable $at = null;
    private ?string $stack = null;

    /**
     * @internal Construct via {@see BlokError::dependency()},
     * {@see BlokError::validation()}, etc.
     */
    public function __construct(BlokErrorCategory $category)
    {
        $this->category = $category;
        $this->httpStatus = $category->defaultHttpStatus();
        $this->retryable = $category->defaultRetryable();
    }

    public function code(string $value): self { $this->code = $value; return $this; }
    public function message(string $value): self { $this->message = $value; return $this; }
    public function description(string $value): self { $this->description = $value; return $this; }
    public function remediation(string $value): self { $this->remediation = $value; return $this; }
    public function docUrl(string $value): self { $this->docUrl = $value; return $this; }
    public function httpStatus(int $value): self { $this->httpStatus = $value; return $this; }
    public function severity(BlokErrorSeverity $value): self { $this->severity = $value; return $this; }
    public function retryable(bool $value): self { $this->retryable = $value; return $this; }
    public function retryAfterMs(int $value): self { $this->retryAfterMs = $value; return $this; }
    public function details(mixed $value): self { $this->details = $value; return $this; }
    public function contextSnapshot(mixed $value): self { $this->contextSnapshot = $value; return $this; }
    public function cause(?Throwable $value): self { $this->cause = $value; return $this; }
    public function node(string $value): self { $this->node = $value; return $this; }
    public function sdk(string $value): self { $this->sdk = $value; return $this; }
    public function sdkVersion(string $value): self { $this->sdkVersion = $value; return $this; }
    public function runtimeKind(string $value): self { $this->runtimeKind = $value; return $this; }
    public function at(\DateTimeImmutable $value): self { $this->at = $value; return $this; }
    public function stack(string $value): self { $this->stack = $value; return $this; }

    /**
     * Suggested retry-after as a {@see \DateInterval}. Stored as milliseconds
     * in the proto wire format.
     */
    public function retryAfter(\DateInterval $duration): self
    {
        $reference = new \DateTimeImmutable('@0');
        $end = $reference->add($duration);
        $this->retryAfterMs = ($end->getTimestamp() * 1000) + (int) ($duration->f * 1000);
        return $this;
    }

    /**
     * Apply origin fields, only filling unset ones. Use this in the
     * runtime-side wrapping path; explicit handler-set values win.
     */
    public function applyOrigin(Origin $origin): self
    {
        if ($this->node === '') $this->node = $origin->node;
        if ($this->sdk === '') $this->sdk = $origin->sdk;
        if ($this->sdkVersion === '') $this->sdkVersion = $origin->sdkVersion;
        if ($this->runtimeKind === '') $this->runtimeKind = $origin->runtimeKind;
        return $this;
    }

    /** Finalize into a {@see BlokError}. */
    public function build(): BlokError
    {
        return new BlokError(
            category: $this->category,
            code: $this->code,
            message: $this->message,
            description: $this->description,
            remediation: $this->remediation,
            docUrl: $this->docUrl,
            cause: $this->cause,
            retryable: $this->retryable,
            retryAfterMs: $this->retryAfterMs,
            details: $this->details,
            contextSnapshot: $this->contextSnapshot,
            httpStatus: $this->httpStatus,
            severity: $this->severity,
            node: $this->node,
            sdk: $this->sdk,
            sdkVersion: $this->sdkVersion,
            runtimeKind: $this->runtimeKind,
            at: $this->at,
            stack: $this->stack,
        );
    }
}
