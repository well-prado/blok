namespace Blok.Core.Errors;

/// <summary>
/// How serious an error is. Mirrors the proto
/// <c>blok.runtime.v1.ErrorSeverity</c> enum. Default for thrown errors is
/// <see cref="Error"/>.
/// </summary>
public enum BlokErrorSeverity
{
    /// <summary>Informational, no action needed.</summary>
    Info,
    /// <summary>Recoverable, worth surfacing.</summary>
    Warn,
    /// <summary>Standard error level.</summary>
    Error,
    /// <summary>Process must terminate.</summary>
    Fatal,
}

public static class BlokErrorSeverityExtensions
{
    public static string AsWire(this BlokErrorSeverity severity) => severity switch
    {
        BlokErrorSeverity.Info => "INFO",
        BlokErrorSeverity.Warn => "WARN",
        BlokErrorSeverity.Error => "ERROR",
        BlokErrorSeverity.Fatal => "FATAL",
        _ => "ERROR",
    };

    /// <summary>Parse a wire string, falling back to <see cref="BlokErrorSeverity.Error"/>.</summary>
    public static BlokErrorSeverity Parse(string? value) => value switch
    {
        "INFO" => BlokErrorSeverity.Info,
        "WARN" => BlokErrorSeverity.Warn,
        "ERROR" => BlokErrorSeverity.Error,
        "FATAL" => BlokErrorSeverity.Fatal,
        _ => BlokErrorSeverity.Error,
    };
}
