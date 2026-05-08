using Blok.Core.Logging;

namespace Blok.Core.Config;

/// <summary>Selects which server(s) to start.</summary>
public enum Transport
{
    /// <summary>HTTP only (default; preserves existing behavior).</summary>
    Http,
    /// <summary>gRPC only on <see cref="ServerConfig.GrpcPort" />.</summary>
    Grpc,
    /// <summary>HTTP and gRPC concurrently — used during migration.</summary>
    Both,
}

/// <summary>
/// Server configuration loaded from environment variables.
/// </summary>
public class ServerConfig
{
    /// <summary>HTTP port to listen on. Default: 9004 (matches the runner's
    /// <c>DEFAULT_PORTS.csharp</c>).</summary>
    public int Port { get; set; } = 9004;

    /// <summary>Host address to bind to. Default: 0.0.0.0.</summary>
    public string Host { get; set; } = "0.0.0.0";

    /// <summary>Runtime version string. Default: 1.0.0.</summary>
    public string Version { get; set; } = "1.0.0";

    /// <summary>gRPC port to listen on. Default: 10004 (matches the runner's
    /// <c>DEFAULT_GRPC_PORTS.csharp = HTTP+1000</c>).</summary>
    public int GrpcPort { get; set; } = 10004;

    /// <summary>Selects which server(s) to start. Default: <see cref="Transport.Http" />.</summary>
    public Transport Transport { get; set; } = Transport.Http;

    /// <summary>Minimum log level. Default: Info.</summary>
    public Logging.LogLevel LogLevel { get; set; } = Logging.LogLevel.Info;

    /// <summary>Whether to enable CORS. Default: false.</summary>
    public bool EnableCors { get; set; } = false;

    /// <summary>
    /// Load configuration from environment variables with defaults.
    /// - PORT (default: 9004)
    /// - HOST (default: 0.0.0.0)
    /// - VERSION (default: 1.0.0)
    /// - GRPC_PORT (default: 10004)
    /// - BLOK_TRANSPORT: "http" | "grpc" | "both" (default: "http")
    /// - LOG_LEVEL (default: INFO)
    /// - ENABLE_CORS (default: false)
    /// </summary>
    public static ServerConfig FromEnv()
    {
        return new ServerConfig
        {
            Port = int.TryParse(Environment.GetEnvironmentVariable("PORT"), out var port) ? port : 9004,
            Host = Environment.GetEnvironmentVariable("HOST") ?? "0.0.0.0",
            Version = Environment.GetEnvironmentVariable("VERSION") ?? "1.0.0",
            GrpcPort = int.TryParse(Environment.GetEnvironmentVariable("GRPC_PORT"), out var grpcPort) ? grpcPort : 10004,
            Transport = ParseTransport(Environment.GetEnvironmentVariable("BLOK_TRANSPORT")),
            LogLevel = ParseLogLevel(Environment.GetEnvironmentVariable("LOG_LEVEL")),
            EnableCors = bool.TryParse(Environment.GetEnvironmentVariable("ENABLE_CORS"), out var cors) && cors
        };
    }

    private static Transport ParseTransport(string? value) => value?.ToLowerInvariant() switch
    {
        "grpc" => Transport.Grpc,
        "both" => Transport.Both,
        _ => Transport.Http,
    };

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
