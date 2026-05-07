namespace Blok.Core.Errors;

/// <summary>
/// The 12 canonical error categories every Blok node error falls into.
///
/// <para>Mirrors the proto <c>blok.runtime.v1.ErrorCategory</c> enum
/// value-for-value and matches the Python <c>BlokErrorCategory</c>, Go
/// <c>CategoryDependency</c>, Rust <c>BlokErrorCategory::Dependency</c>, and
/// Java <c>BlokErrorCategory.DEPENDENCY</c> constants. Each category carries a
/// default HTTP status and retryable hint that authors can override
/// per-error via the builder.</para>
/// </summary>
public enum BlokErrorCategory
{
    /// <summary>Input failed schema validation. Default HTTP 400, non-retryable.</summary>
    Validation,
    /// <summary>Misconfiguration of the runner / node / environment. Default 500, non-retryable.</summary>
    Configuration,
    /// <summary>External dependency unreachable (DB, API). Default 502, retryable.</summary>
    Dependency,
    /// <summary>Deadline exceeded. Default 504, retryable.</summary>
    Timeout,
    /// <summary>Caller lacks the right role/scope. Default 403, non-retryable.</summary>
    Permission,
    /// <summary>Caller exceeded a quota. Default 429, retryable with retry_after_ms.</summary>
    RateLimit,
    /// <summary>Resource not found. Default 404, non-retryable.</summary>
    NotFound,
    /// <summary>Idempotency violation, concurrent update. Default 409, non-retryable.</summary>
    Conflict,
    /// <summary>Caller cancelled before completion. Default 499, non-retryable.</summary>
    Cancelled,
    /// <summary>SDK threw without classification — default fallback. Default 500, non-retryable.</summary>
    Internal,
    /// <summary>Wire-format / framing / serialization error. Default 502, non-retryable.</summary>
    Protocol,
    /// <summary>Payload schema OK but values are unprocessable. Default 422, non-retryable.</summary>
    Data,
}

/// <summary>
/// Per-category default tables and string conversions for
/// <see cref="BlokErrorCategory"/>. C# enums can't carry data like Java's, so
/// the lookup tables live as extension methods here.
/// </summary>
public static class BlokErrorCategoryExtensions
{
    /// <summary>HTTP status conventionally associated with this category.</summary>
    public static int DefaultHttpStatus(this BlokErrorCategory category) => category switch
    {
        BlokErrorCategory.Validation => 400,
        BlokErrorCategory.Configuration => 500,
        BlokErrorCategory.Dependency => 502,
        BlokErrorCategory.Timeout => 504,
        BlokErrorCategory.Permission => 403,
        BlokErrorCategory.RateLimit => 429,
        BlokErrorCategory.NotFound => 404,
        BlokErrorCategory.Conflict => 409,
        BlokErrorCategory.Cancelled => 499,
        BlokErrorCategory.Internal => 500,
        BlokErrorCategory.Protocol => 502,
        BlokErrorCategory.Data => 422,
        _ => 500,
    };

    /// <summary>Retryable hint conventionally associated with this category.</summary>
    public static bool DefaultRetryable(this BlokErrorCategory category) => category switch
    {
        BlokErrorCategory.Dependency => true,
        BlokErrorCategory.Timeout => true,
        BlokErrorCategory.RateLimit => true,
        _ => false,
    };

    /// <summary>String form matching the proto enum name (e.g. <c>"DEPENDENCY"</c>).</summary>
    public static string AsWire(this BlokErrorCategory category) => category switch
    {
        BlokErrorCategory.Validation => "VALIDATION",
        BlokErrorCategory.Configuration => "CONFIGURATION",
        BlokErrorCategory.Dependency => "DEPENDENCY",
        BlokErrorCategory.Timeout => "TIMEOUT",
        BlokErrorCategory.Permission => "PERMISSION",
        BlokErrorCategory.RateLimit => "RATE_LIMIT",
        BlokErrorCategory.NotFound => "NOT_FOUND",
        BlokErrorCategory.Conflict => "CONFLICT",
        BlokErrorCategory.Cancelled => "CANCELLED",
        BlokErrorCategory.Internal => "INTERNAL",
        BlokErrorCategory.Protocol => "PROTOCOL",
        BlokErrorCategory.Data => "DATA",
        _ => "INTERNAL",
    };

    /// <summary>
    /// Parse a wire string into a category, falling back to <see cref="BlokErrorCategory.Internal"/>
    /// for unknown values (matches Python/Go/Rust/Java behaviour).
    /// </summary>
    public static BlokErrorCategory Parse(string? value) => value switch
    {
        "VALIDATION" => BlokErrorCategory.Validation,
        "CONFIGURATION" => BlokErrorCategory.Configuration,
        "DEPENDENCY" => BlokErrorCategory.Dependency,
        "TIMEOUT" => BlokErrorCategory.Timeout,
        "PERMISSION" => BlokErrorCategory.Permission,
        "RATE_LIMIT" => BlokErrorCategory.RateLimit,
        "NOT_FOUND" => BlokErrorCategory.NotFound,
        "CONFLICT" => BlokErrorCategory.Conflict,
        "CANCELLED" => BlokErrorCategory.Cancelled,
        "PROTOCOL" => BlokErrorCategory.Protocol,
        "DATA" => BlokErrorCategory.Data,
        _ => BlokErrorCategory.Internal,
    };
}
