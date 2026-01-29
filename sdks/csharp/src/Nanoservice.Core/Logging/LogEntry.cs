namespace Nanoservice.Core.Logging;

/// <summary>
/// A single log entry captured by the Logger.
/// </summary>
public class LogEntry
{
    public LogLevel Level { get; set; }
    public string Message { get; set; } = string.Empty;
    public DateTime Timestamp { get; set; }
    public Dictionary<string, object?>? Fields { get; set; }

    public override string ToString()
    {
        var levelStr = Level switch
        {
            LogLevel.Debug => "DEBUG",
            LogLevel.Info => "INFO",
            LogLevel.Warn => "WARN",
            LogLevel.Error => "ERROR",
            _ => "UNKNOWN"
        };

        var ts = Timestamp.ToString("O");

        if (Fields is not null && Fields.Count > 0)
        {
            var fieldsStr = string.Join(", ", Fields.Select(kv => $"{kv.Key}={kv.Value}"));
            return $"[{levelStr}] {ts} {Message} {{{fieldsStr}}}";
        }

        return $"[{levelStr}] {ts} {Message}";
    }
}
