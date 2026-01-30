namespace Blok.Core.Logging;

/// <summary>
/// Logger captures log entries for inclusion in ExecutionResult.logs.
/// Thread-safe via lock.
/// </summary>
public class Logger
{
    private readonly List<LogEntry> _entries = new();
    private readonly object _lock = new();
    private readonly LogLevel _minLevel;

    public Logger(LogLevel minLevel = LogLevel.Info)
    {
        _minLevel = minLevel;
    }

    private void Log(LogLevel level, string message, Dictionary<string, object?>? fields = null)
    {
        if (level < _minLevel) return;

        var entry = new LogEntry
        {
            Level = level,
            Message = message,
            Timestamp = DateTime.UtcNow,
            Fields = fields
        };

        lock (_lock)
        {
            _entries.Add(entry);
        }
    }

    /// <summary>Log a debug message.</summary>
    public void Debug(string message) => Log(LogLevel.Debug, message);

    /// <summary>Log a debug message with fields.</summary>
    public void Debug(string message, Dictionary<string, object?> fields) => Log(LogLevel.Debug, message, fields);

    /// <summary>Log an info message.</summary>
    public void Info(string message) => Log(LogLevel.Info, message);

    /// <summary>Log an info message with fields.</summary>
    public void Info(string message, Dictionary<string, object?> fields) => Log(LogLevel.Info, message, fields);

    /// <summary>Log a warning message.</summary>
    public void Warn(string message) => Log(LogLevel.Warn, message);

    /// <summary>Log a warning message with fields.</summary>
    public void Warn(string message, Dictionary<string, object?> fields) => Log(LogLevel.Warn, message, fields);

    /// <summary>Log an error message.</summary>
    public void Error(string message) => Log(LogLevel.Error, message);

    /// <summary>Log an error message with fields.</summary>
    public void Error(string message, Dictionary<string, object?> fields) => Log(LogLevel.Error, message, fields);

    /// <summary>
    /// Get all captured log entries.
    /// </summary>
    public List<LogEntry> Entries()
    {
        lock (_lock)
        {
            return new List<LogEntry>(_entries);
        }
    }

    /// <summary>
    /// Get log entries as formatted strings for ExecutionResult.logs.
    /// </summary>
    public List<string> Lines()
    {
        lock (_lock)
        {
            return _entries.Select(e => e.ToString()).ToList();
        }
    }

    /// <summary>
    /// Clear all captured entries.
    /// </summary>
    public void Clear()
    {
        lock (_lock)
        {
            _entries.Clear();
        }
    }
}
