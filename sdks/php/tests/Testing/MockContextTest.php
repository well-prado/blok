<?php

declare(strict_types=1);

namespace Blok\Nanoservice\Tests\Testing;

use Blok\Nanoservice\Testing\MockContext;
use PHPUnit\Framework\TestCase;

final class MockContextTest extends TestCase
{
    public function testDefaultValues(): void
    {
        $ctx = MockContext::create()->build();

        $this->assertSame('test-execution-id', $ctx->id);
        $this->assertSame('test-workflow', $ctx->workflowName);
        $this->assertSame('/workflows/test', $ctx->workflowPath);
        $this->assertSame('POST', $ctx->request->method);
        $this->assertSame('/test', $ctx->request->url);
        $this->assertSame('http://localhost:8080', $ctx->request->baseUrl);
        $this->assertEmpty($ctx->vars);
        $this->assertEmpty($ctx->env);
    }

    public function testWithId(): void
    {
        $ctx = MockContext::create()
            ->withId('custom-id')
            ->build();

        $this->assertSame('custom-id', $ctx->id);
    }

    public function testWithWorkflow(): void
    {
        $ctx = MockContext::create()
            ->withWorkflow('my-workflow', '/workflows/my')
            ->build();

        $this->assertSame('my-workflow', $ctx->workflowName);
        $this->assertSame('/workflows/my', $ctx->workflowPath);
    }

    public function testWithBody(): void
    {
        $ctx = MockContext::create()
            ->withBody(['name' => 'test', 'value' => 42])
            ->build();

        $this->assertSame(['name' => 'test', 'value' => 42], $ctx->request->body);
        $this->assertSame('test', $ctx->request->bodyStr('name'));
    }

    public function testWithHeaders(): void
    {
        $ctx = MockContext::create()
            ->withHeaders(['Authorization' => 'Bearer token', 'Accept' => 'application/json'])
            ->build();

        $this->assertSame('Bearer token', $ctx->request->headers['Authorization']);
        $this->assertSame('application/json', $ctx->request->headers['Accept']);
    }

    public function testWithMethod(): void
    {
        $ctx = MockContext::create()
            ->withMethod('GET')
            ->build();

        $this->assertSame('GET', $ctx->request->method);
    }

    public function testWithUrl(): void
    {
        $ctx = MockContext::create()
            ->withUrl('/api/users')
            ->build();

        $this->assertSame('/api/users', $ctx->request->url);
    }

    public function testWithVar(): void
    {
        $ctx = MockContext::create()
            ->withVar('key1', 'value1')
            ->withVar('key2', ['nested' => true])
            ->build();

        $this->assertSame('value1', $ctx->getVar('key1'));
        $this->assertSame(['nested' => true], $ctx->getVar('key2'));
        $this->assertSame('value1', $ctx->getVarStr('key1'));
    }

    public function testWithEnv(): void
    {
        $ctx = MockContext::create()
            ->withEnv('API_KEY', 'secret-key')
            ->withEnv('DEBUG', 'true')
            ->build();

        $this->assertSame('secret-key', $ctx->env['API_KEY']);
        $this->assertSame('true', $ctx->env['DEBUG']);
    }

    public function testWithParams(): void
    {
        $ctx = MockContext::create()
            ->withParams(['id' => '123'])
            ->build();

        $this->assertSame('123', $ctx->request->params['id']);
    }

    public function testWithQuery(): void
    {
        $ctx = MockContext::create()
            ->withQuery(['page' => '1', 'limit' => '10'])
            ->build();

        $this->assertSame('1', $ctx->request->query['page']);
        $this->assertSame('10', $ctx->request->query['limit']);
    }

    public function testFluentChaining(): void
    {
        $ctx = MockContext::create()
            ->withId('chain-test')
            ->withWorkflow('wf', '/wf')
            ->withBody(['name' => 'test'])
            ->withHeaders(['X-Custom' => 'yes'])
            ->withMethod('PUT')
            ->withVar('prev', 'result')
            ->withEnv('MODE', 'test')
            ->build();

        $this->assertSame('chain-test', $ctx->id);
        $this->assertSame('wf', $ctx->workflowName);
        $this->assertSame(['name' => 'test'], $ctx->request->body);
        $this->assertSame('yes', $ctx->request->headers['X-Custom']);
        $this->assertSame('PUT', $ctx->request->method);
        $this->assertSame('result', $ctx->getVarStr('prev'));
        $this->assertSame('test', $ctx->env['MODE']);
    }

    public function testContextSetAndGetVar(): void
    {
        $ctx = MockContext::create()->build();

        $ctx->setVar('key', 'value');
        $this->assertSame('value', $ctx->getVar('key'));
        $this->assertSame('value', $ctx->getVarStr('key'));
        $this->assertNull($ctx->getVar('missing'));
        $this->assertNull($ctx->getVarStr('missing'));
    }

    public function testContextGetVarStrReturnsNullForNonString(): void
    {
        $ctx = MockContext::create()
            ->withVar('number', 42)
            ->build();

        $this->assertSame(42, $ctx->getVar('number'));
        $this->assertNull($ctx->getVarStr('number'));
    }

    public function testContextToArrayAndFromArray(): void
    {
        $ctx = MockContext::create()
            ->withId('round-trip')
            ->withWorkflow('test-wf', '/test')
            ->withBody(['name' => 'test'])
            ->withVar('key', 'val')
            ->build();

        $array = $ctx->toArray();

        $this->assertSame('round-trip', $array['id']);
        $this->assertSame('test-wf', $array['workflow_name']);
        $this->assertSame('/test', $array['workflow_path']);
        $this->assertSame(['name' => 'test'], $array['request']['body']);
        $this->assertSame('val', $array['vars']['key']);
    }
}
