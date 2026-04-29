<?php

declare(strict_types=1);

namespace Blok\Blok\Server;

use Blok\Blok\Errors\BlokError;
use Blok\Blok\Errors\BlokErrorCategory as InternalCategory;
use Blok\Blok\Errors\BlokErrorSeverity as InternalSeverity;
use Blok\Blok\Errors\Origin;
use Blok\Blok\Node\NodeRegistry;
use Blok\Blok\Types\Context as BlokContext;
use Blok\Blok\Types\ExecutionRequest as BlokExecutionRequest;
use Blok\Blok\Types\ExecutionResult;
use Blok\Blok\Types\NodeConfig;
use Blok\Blok\Types\Request as BlokRequest;
use Blok\Blok\Types\Response as BlokResponse;
use Blok\Runtime\V1\ErrorCategory;
use Blok\Runtime\V1\ErrorSeverity;
use Blok\Runtime\V1\ExecuteRequest;
use Blok\Runtime\V1\ExecuteResponse;
use Blok\Runtime\V1\HealthRequest;
use Blok\Runtime\V1\HealthResponse;
use Blok\Runtime\V1\HealthResponse\Status as HealthStatus;
use Blok\Runtime\V1\ListNodesRequest;
use Blok\Runtime\V1\ListNodesResponse;
use Blok\Runtime\V1\Metrics;
use Blok\Runtime\V1\NodeDescriptor;
use Blok\Runtime\V1\NodeError;
use Blok\Runtime\V1\RuntimeState;
use Blok\Runtime\V1\TriggerInfo;
use Blok\Runtime\V1\WorkflowInfo;
use Spiral\RoadRunner\GRPC\ContextInterface;
use Spiral\RoadRunner\GRPC\Exception\GRPCException;
use Spiral\RoadRunner\GRPC\Exception\InvokeException;
use Spiral\RoadRunner\GRPC\StatusCode;

/**
 * gRPC implementation of the canonical `blok.runtime.v1.NodeRuntime` v1 service.
 *
 * Owns a reference to a shared {@see NodeRegistry} so a single registry serves
 * both transports. Codec helpers sit at the proto boundary, leaving
 * {@see NodeRegistry::execute()} unchanged regardless of which transport
 * delivered the request.
 *
 * The proto sends `inputs`, `previous_output`, `vars`, and the request `body`
 * as raw JSON-encoded bytes; this class JSON-decodes them lazily.
 */
final class BlokNodeRuntimeService implements NodeRuntimeInterface
{
    private const SDK_NAME = 'blok-php';
    private const RUNTIME_KIND = 'runtime.php';
    private const PROTO_VERSION = '1.0.0';

    public function __construct(
        private readonly NodeRegistry $registry,
        private readonly string $sdkVersion = '1.0.0',
    ) {}

    public function Execute(ContextInterface $ctx, ExecuteRequest $in): ExecuteResponse
    {
        try {
            $internal = $this->decodeExecuteRequest($in);
        } catch (DecodeException $e) {
            throw new InvokeException($e->getMessage(), StatusCode::INVALID_ARGUMENT);
        }

        $nodeName = $internal->node->name;
        $result = $this->registry->execute($internal);

        return $this->encodeExecuteResponse($result, $nodeName);
    }

    public function Health(ContextInterface $ctx, HealthRequest $in): HealthResponse
    {
        return (new HealthResponse())
            ->setStatus(HealthStatus::SERVING)
            ->setSdkVersion($this->sdkVersion)
            ->setRegisteredNodes($this->registry->nodeNames());
    }

    public function ListNodes(ContextInterface $ctx, ListNodesRequest $in): ListNodesResponse
    {
        $descriptors = [];
        foreach ($this->registry->nodeNames() as $name) {
            $descriptors[] = (new NodeDescriptor())->setName($name);
        }

        return (new ListNodesResponse())
            ->setNodes($descriptors)
            ->setSdkName(self::SDK_NAME)
            ->setSdkVersion($this->sdkVersion)
            ->setProtoVersion(self::PROTO_VERSION);
    }

    // ===== Codec — proto <-> internal types =====

    /**
     * @throws DecodeException
     */
    public function decodeExecuteRequest(ExecuteRequest $req): BlokExecutionRequest
    {
        $node = $req->getNode();
        if ($node === null || $node->getName() === '') {
            throw new DecodeException('ExecuteRequest.node is required');
        }

        $inputs = self::decodeJsonObject($req->getInputs(), 'inputs');
        $state = $req->getState() ?? new RuntimeState();
        $trigger = $req->getTrigger() ?? new TriggerInfo();
        $workflow = $req->getWorkflow() ?? new WorkflowInfo();

        $previousOutput = self::decodeJsonValue($state->getPreviousOutput(), 'previous_output');
        $vars = self::decodeJsonObject($state->getVars(), 'vars');
        $headers = self::mapToArray($trigger->getHeaders());
        $body = self::decodeRequestBody($trigger->getBody(), $headers);

        $request = new BlokRequest(
            body: $body,
            headers: $headers,
            params: self::mapToArray($trigger->getParams()),
            query: self::mapToArray($trigger->getQuery()),
            method: $trigger->getMethod(),
            url: $trigger->getUrl(),
            cookies: self::mapToArray($trigger->getCookies()),
            baseUrl: $trigger->getBaseUrl(),
        );

        $response = new BlokResponse(
            data: $previousOutput,
            contentType: 'application/json',
            success: true,
            error: null,
        );

        $context = new BlokContext(
            id: $workflow->getRunId(),
            workflowName: $workflow->getName(),
            workflowPath: $workflow->getPath(),
            request: $request,
            response: $response,
            vars: $vars,
            env: self::mapToArray($state->getEnv()),
        );

        $nodeConfig = new NodeConfig(
            name: $node->getName(),
            type: $node->getType(),
            config: $inputs,
        );

        return new BlokExecutionRequest(node: $nodeConfig, context: $context);
    }

    public function encodeExecuteResponse(ExecutionResult $result, string $nodeName): ExecuteResponse
    {
        $response = (new ExecuteResponse())
            ->setSuccess($result->success)
            ->setContentType('application/json');

        if ($result->success && $result->data !== null) {
            $response->setData(self::encodeJsonBytes($result->data));
        }

        if (is_array($result->vars) && $result->vars !== []) {
            $response->setVarsDelta(self::encodeJsonBytes($result->vars));
        }

        if ($result->metrics !== null) {
            $response->setMetrics(
                (new Metrics())
                    ->setDurationMs((float) $result->metrics->durationMs)
                    ->setMemoryBytes((int) $result->metrics->memoryBytes),
            );
        }

        if (! $result->success) {
            $response->setError($this->internalErrorToProto($result->errors, $nodeName));
        }

        return $response;
    }

    /**
     * Build a proto {@see NodeError} from whatever {@see ExecutionResult}
     * carried.
     *
     * Two paths, both producing the same proto shape:
     * - **Structured (preferred)** — `$err` is a typed {@see BlokError}.
     *   All 19 fields serialize losslessly via {@see self::blokErrorToProto()}.
     *   Auto-fills `node`/`sdk`/`sdk_version`/`runtime_kind` if the BlokError
     *   didn't set them itself.
     * - **Loose** — `$err` is anything else (array, string, null, Throwable).
     *   Wrapped via {@see BlokError::fromUnknown()} (always produces
     *   `category=INTERNAL` with the original payload preserved in
     *   `details_json`) and then serialized via the structured path.
     */
    public function internalErrorToProto(mixed $err, string $nodeName): NodeError
    {
        $origin = Origin::defaults($nodeName, $this->sdkVersion);
        if ($err instanceof BlokError) {
            $err->applyOriginIfMissing($origin);
            return $this->blokErrorToProto($err);
        }
        return $this->blokErrorToProto(BlokError::fromUnknown($err, $origin));
    }

    /**
     * Serialize a fully-populated {@see BlokError} into the proto wire
     * format. The cause chain is serialized as a list of proto NodeError
     * messages; each element's own `causes` list is left empty (the chain
     * is already flat at the BlokError layer).
     */
    private function blokErrorToProto(BlokError $err): NodeError
    {
        $node = (new NodeError())
            ->setCode($err->errorCode)
            ->setCategory(self::categoryToProto($err->category))
            ->setSeverity(self::severityToProto($err->severity))
            ->setNode($err->node)
            ->setSdk($err->sdk)
            ->setSdkVersion($err->sdkVersion)
            ->setRuntimeKind($err->runtimeKind)
            ->setMessage($err->getMessage())
            ->setDescription($err->description)
            ->setRemediation($err->remediation)
            ->setDocUrl($err->docUrl)
            ->setStack($err->stack)
            ->setHttpStatus($err->httpStatus)
            ->setRetryable($err->retryable)
            ->setRetryAfterMs($err->retryAfterMs);

        $node->setAt(self::timeToProto($err->at));
        if ($err->details !== null) {
            $node->setDetailsJson(self::encodeJsonBytes($err->details));
        }
        if ($err->contextSnapshot !== null) {
            $node->setContextSnapshotJson(self::encodeJsonBytes($err->contextSnapshot));
        }

        $causes = [];
        foreach ($err->causes as $causePayload) {
            $causes[] = self::causeArrayToProto($causePayload);
        }
        $node->setCauses($causes);
        return $node;
    }

    /**
     * Convert one cause-chain link (already a snake_case array) into a proto
     * {@see NodeError}. Each link's own `causes` list is left empty.
     *
     * @param array<string, mixed> $cause
     */
    private static function causeArrayToProto(array $cause): NodeError
    {
        $category = InternalCategory::parse(self::strField($cause, 'category'));
        $severity = InternalSeverity::parse(self::strField($cause, 'severity'));
        $node = (new NodeError())
            ->setCode(self::strField($cause, 'code'))
            ->setCategory(self::categoryToProto($category))
            ->setSeverity(self::severityToProto($severity))
            ->setNode(self::strField($cause, 'node'))
            ->setSdk(self::strField($cause, 'sdk'))
            ->setSdkVersion(self::strField($cause, 'sdk_version'))
            ->setRuntimeKind(self::strField($cause, 'runtime_kind'))
            ->setMessage(self::strField($cause, 'message'))
            ->setDescription(self::strField($cause, 'description'))
            ->setRemediation(self::strField($cause, 'remediation'))
            ->setDocUrl(self::strField($cause, 'doc_url'))
            ->setStack(self::strField($cause, 'stack'))
            ->setHttpStatus(self::intField($cause, 'http_status', 500))
            ->setRetryable(self::boolField($cause, 'retryable', false))
            ->setRetryAfterMs(self::intField($cause, 'retry_after_ms', 0));

        $atRaw = $cause['at'] ?? null;
        if (is_string($atRaw) && $atRaw !== '') {
            try {
                $node->setAt(self::timeToProto(new \DateTimeImmutable($atRaw)));
            } catch (\Exception) {
                // best effort
            }
        }

        if (isset($cause['details']) && $cause['details'] !== null) {
            $node->setDetailsJson(self::encodeJsonBytes($cause['details']));
        }
        if (isset($cause['context_snapshot']) && $cause['context_snapshot'] !== null) {
            $node->setContextSnapshotJson(self::encodeJsonBytes($cause['context_snapshot']));
        }
        return $node;
    }

    private static function categoryToProto(InternalCategory $c): int
    {
        return match ($c) {
            InternalCategory::Validation => ErrorCategory::VALIDATION,
            InternalCategory::Configuration => ErrorCategory::CONFIGURATION,
            InternalCategory::Dependency => ErrorCategory::DEPENDENCY,
            InternalCategory::Timeout => ErrorCategory::TIMEOUT,
            InternalCategory::Permission => ErrorCategory::PERMISSION,
            InternalCategory::RateLimit => ErrorCategory::RATE_LIMIT,
            InternalCategory::NotFound => ErrorCategory::NOT_FOUND,
            InternalCategory::Conflict => ErrorCategory::CONFLICT,
            InternalCategory::Cancelled => ErrorCategory::CANCELLED,
            InternalCategory::Protocol => ErrorCategory::PROTOCOL,
            InternalCategory::Data => ErrorCategory::DATA,
            InternalCategory::Internal => ErrorCategory::INTERNAL,
        };
    }

    private static function severityToProto(InternalSeverity $s): int
    {
        return match ($s) {
            InternalSeverity::Info => ErrorSeverity::INFO,
            InternalSeverity::Warn => ErrorSeverity::WARN,
            InternalSeverity::Fatal => ErrorSeverity::FATAL,
            default => ErrorSeverity::ERROR,
        };
    }

    private static function timeToProto(\DateTimeImmutable $time): \Google\Protobuf\Timestamp
    {
        $ts = new \Google\Protobuf\Timestamp();
        $ts->setSeconds($time->getTimestamp());
        $ts->setNanos((int) ((int) $time->format('u') * 1000));
        return $ts;
    }

    /**
     * @param array<string, mixed> $m
     */
    private static function strField(array $m, string $key): string
    {
        $v = $m[$key] ?? null;
        return is_string($v) ? $v : '';
    }

    /**
     * @param array<string, mixed> $m
     */
    private static function intField(array $m, string $key, int $fallback): int
    {
        $v = $m[$key] ?? null;
        if (is_int($v)) return $v;
        if (is_float($v)) return (int) $v;
        if (is_string($v) && is_numeric($v)) return (int) $v;
        return $fallback;
    }

    /**
     * @param array<string, mixed> $m
     */
    private static function boolField(array $m, string $key, bool $fallback): bool
    {
        $v = $m[$key] ?? null;
        return is_bool($v) ? $v : $fallback;
    }

    /**
     * Decode JSON-encoded bytes into an associative array. Non-object payloads
     * are wrapped under `_value` so handlers expecting an array don't crash.
     *
     * The wire format always encodes maps as JSON objects (`{}`); this method
     * inspects the first non-whitespace byte to distinguish object from array,
     * since PHP cannot tell empty `{}` from empty `[]` after decoding.
     *
     * @return array<string, mixed>
     * @throws DecodeException
     */
    public static function decodeJsonObject(string $bytes, string $field): array
    {
        if ($bytes === '') {
            return [];
        }

        $parsed = json_decode($bytes, true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            throw new DecodeException(sprintf('invalid `%s` JSON: %s', $field, json_last_error_msg()));
        }

        $firstChar = ltrim($bytes)[0] ?? '';
        if ($firstChar === '{' && is_array($parsed)) {
            return $parsed;
        }

        return ['_value' => $parsed];
    }

    /**
     * Decode JSON-encoded bytes into any value (object, array, scalar, null).
     *
     * @throws DecodeException
     */
    public static function decodeJsonValue(string $bytes, string $field): mixed
    {
        if ($bytes === '') {
            return null;
        }

        $parsed = json_decode($bytes, true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            throw new DecodeException(sprintf('invalid `%s` JSON: %s', $field, json_last_error_msg()));
        }

        return $parsed;
    }

    /**
     * Decode the trigger body bytes. Parses as JSON when Content-Type is JSON;
     * otherwise returns the raw UTF-8 string.
     *
     * @param array<string, string> $headers
     */
    public static function decodeRequestBody(string $bytes, array $headers): mixed
    {
        if ($bytes === '') {
            return null;
        }

        $contentType = strtolower(self::pickHeader($headers, 'content-type'));
        if (str_contains($contentType, 'application/json')) {
            $parsed = json_decode($bytes, true);
            if (json_last_error() === JSON_ERROR_NONE) {
                return $parsed;
            }
            // fall through and return as raw string
        }

        return $bytes;
    }

    /**
     * Encode any value as a JSON byte string.
     */
    public static function encodeJsonBytes(mixed $value): string
    {
        $json = json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        return $json === false ? '{}' : $json;
    }

    /**
     * Case-insensitive header lookup.
     *
     * @param array<string, string> $headers
     */
    public static function pickHeader(array $headers, string $name): string
    {
        $needle = strtolower($name);
        foreach ($headers as $key => $value) {
            if (strtolower((string) $key) === $needle) {
                return (string) $value;
            }
        }
        return '';
    }

    /**
     * Convert a proto MapField into a plain associative array.
     *
     * @return array<string, string>
     */
    private static function mapToArray(mixed $map): array
    {
        if ($map === null) {
            return [];
        }

        $out = [];
        foreach ($map as $k => $v) {
            $out[(string) $k] = (string) $v;
        }
        return $out;
    }
}
