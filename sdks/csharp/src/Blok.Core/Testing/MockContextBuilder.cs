using System.Text.Json;
using Blok.Core.Types;

namespace Blok.Core.Testing;

/// <summary>
/// Fluent builder for creating test Context instances.
/// </summary>
public class MockContextBuilder
{
    private string _id = "test-execution-id";
    private string _workflowName = "test-workflow";
    private string _workflowPath = "/workflows/test";
    private JsonElement _body;
    private Dictionary<string, string> _headers = new();
    private Dictionary<string, string> _params = new();
    private Dictionary<string, string> _query = new();
    private string _method = "POST";
    private string _url = "/test";
    private Dictionary<string, object?> _vars = new();
    private Dictionary<string, string> _env = new();

    public MockContextBuilder()
    {
        _body = JsonDocument.Parse("{}").RootElement.Clone();
    }

    /// <summary>Set the execution ID.</summary>
    public MockContextBuilder WithId(string id)
    {
        _id = id;
        return this;
    }

    /// <summary>Set the workflow name and path.</summary>
    public MockContextBuilder WithWorkflow(string name, string path)
    {
        _workflowName = name;
        _workflowPath = path;
        return this;
    }

    /// <summary>Set the request body from a JSON string.</summary>
    public MockContextBuilder WithBody(string json)
    {
        _body = JsonDocument.Parse(json).RootElement.Clone();
        return this;
    }

    /// <summary>Set the request body from an object.</summary>
    public MockContextBuilder WithBody(object body)
    {
        var json = JsonSerializer.Serialize(body);
        _body = JsonDocument.Parse(json).RootElement.Clone();
        return this;
    }

    /// <summary>Set the request body from a JsonElement.</summary>
    public MockContextBuilder WithBody(JsonElement body)
    {
        _body = body.Clone();
        return this;
    }

    /// <summary>Set the request headers.</summary>
    public MockContextBuilder WithHeaders(Dictionary<string, string> headers)
    {
        _headers = headers;
        return this;
    }

    /// <summary>Set the request method.</summary>
    public MockContextBuilder WithMethod(string method)
    {
        _method = method;
        return this;
    }

    /// <summary>Set a context variable.</summary>
    public MockContextBuilder WithVar(string key, object? value)
    {
        _vars[key] = value;
        return this;
    }

    /// <summary>Set an environment variable.</summary>
    public MockContextBuilder WithEnv(string key, string value)
    {
        _env[key] = value;
        return this;
    }

    /// <summary>Build the context.</summary>
    public Context Build()
    {
        return new Context
        {
            Id = _id,
            WorkflowName = _workflowName,
            WorkflowPath = _workflowPath,
            Request = new Request
            {
                Body = _body,
                Headers = _headers,
                Params = _params,
                Query = _query,
                Method = _method,
                Url = _url,
                Cookies = new Dictionary<string, string>(),
                BaseUrl = "http://localhost:8080"
            },
            Response = new Response(),
            Vars = _vars,
            Env = _env
        };
    }
}
