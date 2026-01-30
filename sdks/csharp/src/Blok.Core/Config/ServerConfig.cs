using Blok.Core.Logging;

namespace Blok.Core.Config;

/// <summary>
/// Server configuration loaded from environment variables.
/// </summary>
public class ServerConfig
{
    /// <summary>TCP port to listen on. Default: 8080.</summary>
    public int Port { get; set; } = 8080;

    /// <summary>Host address to bind to. Default: 0.0.0.0.</summary>
    public string Host { get; set; } = "0.0.0.0";

    /// <summary>Runtime version string. Default: 1.0.0.</summary>
    public string Version { get; set; } = "1.0.0";

    /// <summary>Minimum log level. Default: Info.</summary>
    public Logging.LogLevel LogLevel { get; set; } = Logging.LogLevel.Info;

    /// <summary>Whether to enable CORS. Default: false.</summary>
    public bool EnableCors { get; set; } = false;

    /// <summary>
    /// Load configuration from environment variables with defaults.
    /// - PORT (default: 8080)
    /// - HOST (default: 0.0.0.0)
    /// - VERSION (default: 1.0.0)
    /// - LOG_LEVEL (default: INFO)
    /// - ENABLE_CORS (default: false)
    /// </summary>
    public static ServerConfig FromEnv()
    {
        return new ServerConfig
        {
            Port = int.TryParse(Environment.GetEnvironmentVariable("PORT"), out var port) ? port : 8080,
            Host = Environment.GetEnvironmentVariable("HOST") ?? "0.0.0.0",
            Version = Environment.GetEnvironmentVariable("VERSION") ?? "1.0.0",
            LogLevel = ParseLogLevel(Environment.GetEnvironmentVariable("LOG_LEVEL")),
            EnableCors = bool.TryParse(Environment.GetEnvironmentVariable("ENABLE_CORS"), out var cors) && cors
        };
    }

    /// <summary>
    /// Return the bind address as "host:port".
    /// </summary>
    public string Address() => $"{Host}:{Port}";

    private static Logging.LogLevel ParseLogLevel(string? level)
    {
        return level?.ToUpperInvariant() switch
        {
            "DEBUG" => Logging.LogLevel.Debug,
            "WARN" => Logging.LogLevel.Warn,
            "ERROR" => Logging.LogLevel.Error,
            _ => Logging.LogLevel.Info
        };
    }
}
