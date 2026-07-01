use crate::logging::LogLevel;
use std::env;

/// Server configuration loaded from environment variables.
#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub port: u16,
    pub host: String,
    pub version: String,
    pub grpc_port: u16,
    pub enable_grpc: bool,
    pub log_level: LogLevel,
    pub enable_cors: bool,
    pub shutdown_timeout_secs: u64,
    /// Max gRPC message size in bytes (decode + encode). Must match the
    /// runner client's `BLOK_GRPC_MAX_MESSAGE_BYTES`. Default 16 MiB —
    /// tonic's own default is only 4 MiB, so leaving this unset would reject
    /// payloads the 16 MiB client happily sends.
    pub grpc_max_message_bytes: usize,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            port: 9002,
            host: "0.0.0.0".into(),
            version: "1.0.0".into(),
            // Rust SDK default gRPC port. Mirrors the runner's
            // `DEFAULT_GRPC_PORTS.rust = 10002` (HTTP port 9002 + 1000) so a
            // freshly-launched runner and SDK pair speak by default.
            grpc_port: 10002,
            enable_grpc: false,
            log_level: LogLevel::Info,
            enable_cors: false,
            shutdown_timeout_secs: 10,
            grpc_max_message_bytes: 16 * 1024 * 1024,
        }
    }
}

impl ServerConfig {
    /// Load configuration from environment variables with defaults.
    ///
    /// - `PORT` (default: 9002 — matches `DEFAULT_PORTS.rust` on the runner side)
    /// - `HOST` (default: 0.0.0.0)
    /// - `VERSION` (default: 1.0.0)
    /// - `GRPC_PORT` (default: 10002 — matches `DEFAULT_GRPC_PORTS.rust`)
    /// - `ENABLE_GRPC` (default: false)
    /// - `LOG_LEVEL` (default: INFO)
    /// - `ENABLE_CORS` (default: false)
    /// - `SHUTDOWN_TIMEOUT` (default: 10)
    pub fn from_env() -> Self {
        Self {
            port: env::var("PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(9002),
            host: env::var("HOST").unwrap_or_else(|_| "0.0.0.0".into()),
            version: env::var("VERSION").unwrap_or_else(|_| "1.0.0".into()),
            grpc_port: env::var("GRPC_PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(10002),
            // Honor the standard BLOK_TRANSPORT selector every other Blok SDK +
            // `blokctl dev` set (=grpc); fall back to the legacy ENABLE_GRPC bool.
            enable_grpc: resolve_grpc_enabled(env::var("BLOK_TRANSPORT").ok(), env::var("ENABLE_GRPC").ok()),
            log_level: match env::var("LOG_LEVEL")
                .unwrap_or_else(|_| "INFO".into())
                .as_str()
            {
                "DEBUG" => LogLevel::Debug,
                "WARN" => LogLevel::Warn,
                "ERROR" => LogLevel::Error,
                _ => LogLevel::Info,
            },
            enable_cors: env::var("ENABLE_CORS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(false),
            shutdown_timeout_secs: env::var("SHUTDOWN_TIMEOUT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(10),
            // Must match the runner client + other sidecars. Default 16 MiB
            // (tonic's own default is 4 MiB). Invalid/zero falls back to default.
            grpc_max_message_bytes: env::var("BLOK_GRPC_MAX_MESSAGE_BYTES")
                .ok()
                .and_then(|v| v.parse::<usize>().ok())
                .filter(|&n| n > 0)
                .unwrap_or(16 * 1024 * 1024),
        }
    }

    /// Return the bind address as `host:port`.
    pub fn address(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

/// Resolve whether to start the gRPC server.
///
/// Honors the standard `BLOK_TRANSPORT` selector (`http` | `grpc` | `both`)
/// that every other Blok SDK and `blokctl dev` use — `blokctl dev` sets
/// `BLOK_TRANSPORT=grpc`. Falls back to the legacy `ENABLE_GRPC` boolean when
/// `BLOK_TRANSPORT` is unset or unrecognized (back-compat with older callers +
/// the cross-runtime harness). Without honoring `BLOK_TRANSPORT`, `blokctl dev`
/// left the Rust sidecar in HTTP-only mode and the runner got ECONNREFUSED on
/// the gRPC port.
fn resolve_grpc_enabled(transport: Option<String>, legacy_enable: Option<String>) -> bool {
    match transport.map(|t| t.to_ascii_lowercase()).as_deref() {
        Some("grpc") | Some("both") => true,
        Some("http") => false,
        _ => legacy_enable.and_then(|v| v.parse().ok()).unwrap_or(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_grpc_enabled() {
        // BLOK_TRANSPORT is the primary selector (matches every other SDK).
        assert!(resolve_grpc_enabled(Some("grpc".into()), None));
        assert!(resolve_grpc_enabled(Some("both".into()), None));
        assert!(resolve_grpc_enabled(Some("GRPC".into()), None)); // case-insensitive
        // Explicit http wins over a stale legacy flag.
        assert!(!resolve_grpc_enabled(Some("http".into()), Some("true".into())));
        // Legacy ENABLE_GRPC still works when BLOK_TRANSPORT is unset/unknown.
        assert!(resolve_grpc_enabled(None, Some("true".into())));
        assert!(resolve_grpc_enabled(Some("weird".into()), Some("true".into())));
        // Default off.
        assert!(!resolve_grpc_enabled(None, None));
        assert!(!resolve_grpc_enabled(Some("weird".into()), None));
    }

    #[test]
    fn test_default_config() {
        let cfg = ServerConfig::default();
        assert_eq!(cfg.port, 9002);
        assert_eq!(cfg.host, "0.0.0.0");
        assert_eq!(cfg.version, "1.0.0");
        assert_eq!(cfg.grpc_port, 10002);
        assert!(!cfg.enable_grpc);
        assert!(!cfg.enable_cors);
        assert_eq!(cfg.grpc_max_message_bytes, 16 * 1024 * 1024);
    }

    #[test]
    fn test_address() {
        let cfg = ServerConfig {
            host: "127.0.0.1".into(),
            port: 9090,
            ..Default::default()
        };
        assert_eq!(cfg.address(), "127.0.0.1:9090");
    }
}
