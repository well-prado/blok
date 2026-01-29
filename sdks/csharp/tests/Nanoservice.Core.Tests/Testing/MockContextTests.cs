using System.Text.Json;
using FluentAssertions;
using Nanoservice.Core.Testing;
using Xunit;

namespace Nanoservice.Core.Tests.Testing;

public class MockContextTests
{
    [Fact]
    public void DefaultContext_ShouldHaveDefaults()
    {
        var ctx = new MockContextBuilder().Build();

        ctx.Id.Should().NotBeNullOrEmpty();
        ctx.WorkflowName.Should().Be("test-workflow");
        ctx.WorkflowPath.Should().Be("/workflows/test");
        ctx.Request.Method.Should().Be("POST");
        ctx.Request.Url.Should().Be("/test");
        ctx.Request.BaseUrl.Should().Be("http://localhost:8080");
    }

    [Fact]
    public void WithId_ShouldOverrideId()
    {
        var ctx = new MockContextBuilder()
            .WithId("custom-id")
            .Build();

        ctx.Id.Should().Be("custom-id");
    }

    [Fact]
    public void WithWorkflow_ShouldOverrideWorkflowNameAndPath()
    {
        var ctx = new MockContextBuilder()
            .WithWorkflow("my-workflow", "/workflows/my")
            .Build();

        ctx.WorkflowName.Should().Be("my-workflow");
        ctx.WorkflowPath.Should().Be("/workflows/my");
    }

    [Fact]
    public void WithBody_FromString_ShouldSetBody()
    {
        var ctx = new MockContextBuilder()
            .WithBody("{\"name\": \"test\"}")
            .Build();

        ctx.Request.Body.ValueKind.Should().Be(JsonValueKind.Object);
        ctx.Request.Body.GetProperty("name").GetString().Should().Be("test");
    }

    [Fact]
    public void WithBody_FromObject_ShouldSetBody()
    {
        var ctx = new MockContextBuilder()
            .WithBody(new { name = "test", age = 30 })
            .Build();

        ctx.Request.Body.ValueKind.Should().Be(JsonValueKind.Object);
        ctx.Request.Body.GetProperty("name").GetString().Should().Be("test");
        ctx.Request.Body.GetProperty("age").GetInt32().Should().Be(30);
    }

    [Fact]
    public void WithHeaders_ShouldSetHeaders()
    {
        var headers = new Dictionary<string, string>
        {
            { "Authorization", "Bearer token" },
            { "Content-Type", "application/json" }
        };
        var ctx = new MockContextBuilder()
            .WithHeaders(headers)
            .Build();

        ctx.Request.Headers.Should().HaveCount(2);
        ctx.Request.Headers["Authorization"].Should().Be("Bearer token");
    }

    [Fact]
    public void WithVar_ShouldSetContextVariable()
    {
        var ctx = new MockContextBuilder()
            .WithVar("key", "value")
            .WithVar("count", 42)
            .Build();

        ctx.Vars.Should().HaveCount(2);
        ctx.GetVarString("key").Should().Be("value");
        ctx.GetVar("count").Should().Be(42);
    }

    [Fact]
    public void WithEnv_ShouldSetEnvironmentVariable()
    {
        var ctx = new MockContextBuilder()
            .WithEnv("API_KEY", "secret")
            .Build();

        ctx.Env.Should().ContainKey("API_KEY");
        ctx.Env["API_KEY"].Should().Be("secret");
    }

    [Fact]
    public void WithMethod_ShouldSetMethod()
    {
        var ctx = new MockContextBuilder()
            .WithMethod("GET")
            .Build();

        ctx.Request.Method.Should().Be("GET");
    }

    [Fact]
    public void FluentChaining_ShouldWork()
    {
        var ctx = new MockContextBuilder()
            .WithId("test-1")
            .WithWorkflow("wf", "/wf")
            .WithBody("{\"x\": 1}")
            .WithMethod("PUT")
            .WithVar("a", "b")
            .WithEnv("K", "V")
            .Build();

        ctx.Id.Should().Be("test-1");
        ctx.WorkflowName.Should().Be("wf");
        ctx.Request.Method.Should().Be("PUT");
        ctx.Vars.Should().ContainKey("a");
        ctx.Env.Should().ContainKey("K");
    }

    [Fact]
    public void Context_SetVar_ShouldWork()
    {
        var ctx = new MockContextBuilder().Build();
        ctx.SetVar("runtime", "csharp");

        ctx.GetVar("runtime").Should().Be("csharp");
        ctx.GetVarString("runtime").Should().Be("csharp");
    }

    [Fact]
    public void Context_GetVar_ShouldReturnNullForMissing()
    {
        var ctx = new MockContextBuilder().Build();
        ctx.GetVar("missing").Should().BeNull();
        ctx.GetVarString("missing").Should().BeNull();
    }
}
