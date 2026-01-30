using System.Text.Json;
using FluentAssertions;
using Blok.Core.Node;
using Blok.Core.Testing;
using Blok.Core.Types;
using Xunit;

namespace Blok.Core.Tests.Node;

public class NodeRegistryTests
{
    private class EchoNode : INodeHandler
    {
        private readonly string _message;

        public EchoNode(string message = "echo")
        {
            _message = message;
        }

        public Task<JsonElement> ExecuteAsync(Context ctx, Dictionary<string, JsonElement> config)
        {
            var json = JsonSerializer.Serialize(new { message = _message });
            var element = JsonDocument.Parse(json).RootElement.Clone();
            return Task.FromResult(element);
        }
    }

    private class FailingNode : INodeHandler
    {
        public Task<JsonElement> ExecuteAsync(Context ctx, Dictionary<string, JsonElement> config)
        {
            throw new InvalidOperationException("intentional failure");
        }
    }

    [Fact]
    public void Register_ShouldAddNode()
    {
        var registry = new NodeRegistry();
        registry.Register("echo", new EchoNode());

        registry.Count.Should().Be(1);
        registry.Get("echo").Should().NotBeNull();
    }

    [Fact]
    public void Get_ShouldReturnNullForMissing()
    {
        var registry = new NodeRegistry();
        registry.Get("missing").Should().BeNull();
    }

    [Fact]
    public void NodeNames_ShouldReturnAllRegistered()
    {
        var registry = new NodeRegistry();
        registry.Register("a", new EchoNode());
        registry.Register("b", new EchoNode());

        var names = registry.NodeNames();
        names.Should().HaveCount(2);
        names.Should().Contain("a");
        names.Should().Contain("b");
    }

    [Fact]
    public async Task ExecuteAsync_ShouldReturnSuccessResult()
    {
        var registry = new NodeRegistry();
        registry.Register("echo", new EchoNode("hello"));

        var ctx = new MockContextBuilder().Build();
        var request = new ExecutionRequest
        {
            Node = new NodeConfig { Name = "echo", Config = new Dictionary<string, JsonElement>() },
            Context = ctx
        };

        var result = await registry.ExecuteAsync(request);

        result.Success.Should().BeTrue();
        result.Metrics.Should().NotBeNull();
        result.Metrics!.DurationMs.Should().BeGreaterOrEqualTo(0);
    }

    [Fact]
    public async Task ExecuteAsync_ShouldReturnErrorForMissingNode()
    {
        var registry = new NodeRegistry();
        var ctx = new MockContextBuilder().Build();
        var request = new ExecutionRequest
        {
            Node = new NodeConfig { Name = "missing", Config = new Dictionary<string, JsonElement>() },
            Context = ctx
        };

        var result = await registry.ExecuteAsync(request);

        result.Success.Should().BeFalse();
    }

    [Fact]
    public async Task ExecuteAsync_ShouldCatchExceptions()
    {
        var registry = new NodeRegistry();
        registry.Register("fail", new FailingNode());

        var ctx = new MockContextBuilder().Build();
        var request = new ExecutionRequest
        {
            Node = new NodeConfig { Name = "fail", Config = new Dictionary<string, JsonElement>() },
            Context = ctx
        };

        var result = await registry.ExecuteAsync(request);

        result.Success.Should().BeFalse();
        result.Metrics.Should().NotBeNull();
    }

    [Fact]
    public void GetHealth_ShouldReturnHealthStatus()
    {
        var registry = new NodeRegistry("2.0.0");
        registry.Register("a", new EchoNode());
        registry.Register("b", new EchoNode());

        var health = registry.GetHealth();

        health.Status.Should().Be("healthy");
        health.Version.Should().Be("2.0.0");
        health.NodesLoaded.Should().HaveCount(2);
    }

    [Fact]
    public void Register_ShouldOverwriteExisting()
    {
        var registry = new NodeRegistry();
        registry.Register("echo", new EchoNode("first"));
        registry.Register("echo", new EchoNode("second"));

        registry.Count.Should().Be(1);
    }
}
