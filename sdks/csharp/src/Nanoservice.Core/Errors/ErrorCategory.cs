namespace Nanoservice.Core.Errors;

/// <summary>
/// ErrorCategory classifies the type of error that occurred.
/// </summary>
public enum ErrorCategory
{
    Validation,
    Execution,
    Configuration,
    Network,
    NotFound
}
