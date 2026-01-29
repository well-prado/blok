namespace Nanoservice.Core.Errors;

/// <summary>
/// NodeException represents a structured error from node execution.
/// </summary>
public class NodeException : Exception
{
    /// <summary>HTTP-style status code.</summary>
    public int Code { get; }

    /// <summary>Error category for classification.</summary>
    public ErrorCategory Category { get; }

    /// <summary>Optional additional details.</summary>
    public Dictionary<string, object?>? Details { get; }

    public NodeException(string message, int code, ErrorCategory category, Dictionary<string, object?>? details = null)
        : base($"[{category.ToString().ToUpperInvariant()}] {message}")
    {
        Code = code;
        Category = category;
        Details = details;
    }

    /// <summary>Create a validation error (400).</summary>
    public static NodeException Validation(string message, Dictionary<string, object?>? details = null)
        => new(message, 400, ErrorCategory.Validation, details);

    /// <summary>Create an execution error (500).</summary>
    public static NodeException Execution(string message, Dictionary<string, object?>? details = null)
        => new(message, 500, ErrorCategory.Execution, details);

    /// <summary>Create a configuration error (500).</summary>
    public static NodeException Configuration(string message, Dictionary<string, object?>? details = null)
        => new(message, 500, ErrorCategory.Configuration, details);

    /// <summary>Create a network error (502).</summary>
    public static NodeException Network(string message, Dictionary<string, object?>? details = null)
        => new(message, 502, ErrorCategory.Network, details);

    /// <summary>Create a not-found error (404).</summary>
    public static NodeException NotFound(string message, Dictionary<string, object?>? details = null)
        => new(message, 404, ErrorCategory.NotFound, details);
}
