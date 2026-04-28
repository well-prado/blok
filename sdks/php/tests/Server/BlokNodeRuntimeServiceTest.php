<?php

declare(strict_types=1);

namespace Blok\Blok\Tests\Server;

use Blok\Blok\Node\NodeHandler;
use Blok\Blok\Node\NodeRegistry;
use Blok\Blok\Server\BlokNodeRuntimeService;
use Blok\Blok\Server\DecodeException;
use Blok\Blok\Server\NodeRuntimeInterface;
use Blok\Blok\Types\Context;
use Blok\Blok\Types\ExecutionResult;
use Blok\Runtime\V1\ErrorCategory;
use Blok\Runtime\V1\ExecuteRequest;
use Blok\Runtime\V1\HealthRequest;
use Blok\Runtime\V1\HealthResponse\Status as HealthStatus;
use Blok\Runtime\V1\ListNodesRequest;
use Blok\Runtime\V1\NodeRef;
use Blok\Runtime\V1\RuntimeState;
use Blok\Runtime\V1\StepInfo;
use Blok\Runtime\V1\TriggerInfo;
use Blok\Runtime\V1\WorkflowInfo;
use Google\Protobuf\Internal\MapField;
use Google\Protobuf\Internal\GPBType;
use PHPUnit\Framework\TestCase;
use Spiral\RoadRunner\GRPC\Context as GrpcContext;

final class BlokNodeRuntimeServiceTest extends TestCase
{
    private function makeRegistry(?NodeHandler $handler = null, string $name = 'hello'): NodeRegistry
    {
        $registry = new NodeRegistry('9.9.9');
        if ($handler !== null) {
            $registry->register($name, $handler);
        }
        return $registry;
    }

    private function makeService(NodeRegistry $registry): BlokNodeRuntimeService
    {
        return new BlokNodeRuntimeService($registry, sdkVersion: '9.9.9');
    }

    private function makeGrpcContext(): GrpcContext
    {
        return new GrpcContext([]);
    }

    /** @param array<string, string> $entries */
    private function stringMap(array $entries): MapField
    {
        $map = new MapField(GPBType::STRING, GPBType::STRING);
        foreach ($entries as $k => $v) {
            $map[$k] = $v;
        }
        return $map;
    }

    public function testServiceImplementsInterfaceWithExpectedName(): void
    {
        $svc = $this->makeService($this->makeRegistry());
        self::assertInstanceOf(NodeRuntimeInterface::class, $svc);
        self::assertSame('blok.runtime.v1.NodeRuntime', NodeRuntimeInterface::NAME);
    }

    public function testHealthReportsServingWithRegisteredNodes(): void
    {
        $reg = $this->makeRegistry(new class implements NodeHandler {
            public function execute(Context $ctx, array $config): mixed
            {
                return null;
            }
        }, 'alpha');
        $reg->register('beta', new class implements NodeHandler {
            public function execute(Context $ctx, array $config): mixed
            {
                return null;
            }
        });

        $resp = $this->makeService($reg)->Health($this->makeGrpcContext(), new HealthRequest());

        self::assertSame(HealthStatus::SERVING, $resp->getStatus());
        self::assertSame('9.9.9', $resp->getSdkVersion());

        $names = [];
        foreach ($resp->getRegisteredNodes() as $n) {
            $names[] = $n;
        }
        self::assertSame(['alpha', 'beta'], $names);
    }

    public function testListNodesReturnsDescriptorsAndSdkMetadata(): void
    {
        $reg = $this->makeRegistry(new class implements NodeHandler {
            public function execute(Context $ctx, array $config): mixed
            {
                return null;
            }
        }, 'alpha');

        $resp = $this->makeService($reg)->ListNodes($this->makeGrpcContext(), new ListNodesRequest());

        self::assertSame('blok-php', $resp->getSdkName());
        self::assertSame('9.9.9', $resp->getSdkVersion());
        self::assertSame('1.0.0', $resp->getProtoVersion());

        $names = [];
        foreach ($resp->getNodes() as $n) {
            $names[] = $n->getName();
        }
        self::assertSame(['alpha'], $names);
    }

    public function testExecuteSuccessRoundTripsDataAndPropagatesVars(): void
    {
        $handler = new class implements NodeHandler {
            public function execute(Context $ctx, array $config): mixed
            {
                $ctx->setVar('greeting', 'hi');
                return [
                    'received_inputs' => $config,
                    'received_body' => $ctx->request->body,
                    'workflow' => $ctx->workflowName,
                ];
            }
        };

        $reg = $this->makeRegistry($handler, 'echo');
        $svc = $this->makeService($reg);

        $req = (new ExecuteRequest())
            ->setNode((new NodeRef())->setName('echo')->setType('runtime.php'))
            ->setInputs(BlokNodeRuntimeService::encodeJsonBytes(['prefix' => 'Hi']))
            ->setStep((new StepInfo())->setName('echo')->setIndex(0)->setTotal(1)->setDepth(0))
            ->setTrigger(
                (new TriggerInfo())
                    ->setBody(BlokNodeRuntimeService::encodeJsonBytes(['name' => 'World']))
                    ->setHeaders($this->stringMap(['Content-Type' => 'application/json']))
                    ->setMethod('POST')
                    ->setUrl('/test'),
            )
            // Runner always sends `vars` as a JSON object (`{}`), never `[]`.
            // PHP's json_encode([]) emits `[]`, which the codec correctly wraps
            // under `_value`, so we set an empty object literal instead.
            ->setState((new RuntimeState())->setVars('{}'))
            ->setWorkflow((new WorkflowInfo())->setRunId('run-1')->setName('wf')->setPath('/wf'));

        $resp = $svc->Execute($this->makeGrpcContext(), $req);

        self::assertTrue($resp->getSuccess());
        self::assertSame('application/json', $resp->getContentType());

        $data = json_decode($resp->getData(), true);
        self::assertSame(['prefix' => 'Hi'], $data['received_inputs']);
        self::assertSame(['name' => 'World'], $data['received_body']);
        self::assertSame('wf', $data['workflow']);

        $varsDelta = json_decode($resp->getVarsDelta(), true);
        self::assertSame(['greeting' => 'hi'], $varsDelta);
    }

    public function testExecuteFailureProducesStructuredNodeError(): void
    {
        $handler = new class implements NodeHandler {
            public function execute(Context $ctx, array $config): mixed
            {
                throw new \RuntimeException('boom');
            }
        };

        $reg = $this->makeRegistry($handler, 'kaboom');
        $svc = $this->makeService($reg);

        $req = (new ExecuteRequest())
            ->setNode((new NodeRef())->setName('kaboom')->setType('runtime.php'));

        $resp = $svc->Execute($this->makeGrpcContext(), $req);

        self::assertFalse($resp->getSuccess());
        $err = $resp->getError();
        self::assertNotNull($err);
        self::assertSame('PHP_NODE_ERROR', $err->getCode());
        self::assertSame(ErrorCategory::INTERNAL, $err->getCategory());
        self::assertSame('kaboom', $err->getNode());
        self::assertSame('blok-php', $err->getSdk());
        self::assertSame('runtime.php', $err->getRuntimeKind());
        self::assertSame('boom', $err->getMessage());
        self::assertSame(500, $err->getHttpStatus());
        self::assertFalse($err->getRetryable());
        self::assertNotSame('', $err->getDetailsJson());
    }

    public function testExecuteWithMissingNodeReturnsStructuredError(): void
    {
        $svc = $this->makeService($this->makeRegistry());

        $req = (new ExecuteRequest())
            ->setNode((new NodeRef())->setName('not-registered')->setType('runtime.php'));

        $resp = $svc->Execute($this->makeGrpcContext(), $req);

        self::assertFalse($resp->getSuccess());
        $err = $resp->getError();
        self::assertNotNull($err);
        self::assertSame('not-registered', $err->getNode());
        self::assertStringContainsStringIgnoringCase('not found', $err->getMessage());
    }

    public function testDecodeJsonObjectReturnsEmptyArrayForEmptyBytes(): void
    {
        self::assertSame([], BlokNodeRuntimeService::decodeJsonObject('', 'inputs'));
    }

    public function testDecodeJsonObjectWrapsNonObjectUnderUnderscoreValue(): void
    {
        self::assertSame(['_value' => [1, 2, 3]], BlokNodeRuntimeService::decodeJsonObject('[1,2,3]', 'inputs'));
        self::assertSame(['_value' => 'hello'], BlokNodeRuntimeService::decodeJsonObject('"hello"', 'inputs'));
    }

    public function testDecodeJsonObjectThrowsOnInvalidJson(): void
    {
        $this->expectException(DecodeException::class);
        $this->expectExceptionMessageMatches('/invalid `inputs` JSON/');
        BlokNodeRuntimeService::decodeJsonObject('{not-json', 'inputs');
    }

    public function testDecodeRequestBodyParsesJsonContentType(): void
    {
        $body = BlokNodeRuntimeService::decodeRequestBody(
            '{"x":1}',
            ['Content-Type' => 'application/json; charset=utf-8'],
        );
        self::assertSame(['x' => 1], $body);
    }

    public function testDecodeRequestBodyReturnsRawForNonJson(): void
    {
        $body = BlokNodeRuntimeService::decodeRequestBody('plain', ['content-type' => 'text/plain']);
        self::assertSame('plain', $body);
    }

    public function testDecodeRequestBodyReturnsNullForEmpty(): void
    {
        self::assertNull(BlokNodeRuntimeService::decodeRequestBody('', []));
    }

    public function testPickHeaderIsCaseInsensitive(): void
    {
        self::assertSame('foo', BlokNodeRuntimeService::pickHeader(['X-Custom' => 'foo'], 'x-custom'));
        self::assertSame('bar', BlokNodeRuntimeService::pickHeader(['Content-Type' => 'bar'], 'CONTENT-TYPE'));
        self::assertSame('', BlokNodeRuntimeService::pickHeader([], 'missing'));
    }

    public function testEncodeJsonBytesPreservesUnicodeAndSlashes(): void
    {
        $encoded = BlokNodeRuntimeService::encodeJsonBytes(['url' => '/path/with/slash', 'unicode' => 'café']);
        self::assertStringContainsString('/path/with/slash', $encoded);
        self::assertStringContainsString('café', $encoded);
    }

    public function testDecodeExecuteRequestRequiresNodeName(): void
    {
        $svc = $this->makeService($this->makeRegistry());
        $this->expectException(DecodeException::class);
        $this->expectExceptionMessage('ExecuteRequest.node is required');
        $svc->decodeExecuteRequest((new ExecuteRequest())->setNode(new NodeRef()));
    }

    public function testInternalErrorToProtoHandlesScalarsAndArrays(): void
    {
        $svc = $this->makeService($this->makeRegistry());

        $err = $svc->internalErrorToProto('boom', 'n');
        self::assertSame('boom', $err->getMessage());

        $err = $svc->internalErrorToProto(['message' => 'bad', 'detail' => 42], 'n');
        self::assertSame('bad', $err->getMessage());
        $details = json_decode($err->getDetailsJson(), true);
        self::assertSame(42, $details['detail']);

        $err = $svc->internalErrorToProto(null, 'n');
        self::assertSame('node error', $err->getMessage());
    }
}
