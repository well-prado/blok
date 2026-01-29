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
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            port: 8080,
            host: "0.0.0.0".into(),
            version: "1.0.0".into(),
            grpc_port: 50051,
            enable_grpc: false,
            log_level: LogLevel::Info,
            enable_cors: false,
            shutdown_timeout_secs: 10,
        }
    }
}

impl ServerConfig {
    /// Load configuration from environment variables with defaults.
    ///
    /// - `PORT` (default: 8080)
    /// - `HOST` (default: 0.0.0.0)
    /// - `VERSION` (default: 1.0.0)
    /// - `GRPC_PORT` (default: 50051)
    /// - `ENABLE_GRPC` (default: false)
    /// - `LOG_LEVEL` (default: INFO)
    /// - `ENABLE_CORS` (default: false)
    /// - `SHUTDOWN_TIMEOUT` (default: 10)
    pub fn from_env() -> Self {
        Self {
            port: env::var("PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(8080),
            host: env::var("HOST").unwrap_or_else(|_| "0.0.0.0".into()),
            version: env::var("VERSION").unwrap_or_else(|_| "1.0.0".into()),
            grpc_port: env::var("GRPC_PORT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(50051),
            enable_grpc: env::var("ENABLE_GRPC")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(false),
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
        }
    }

    /// Return the bind address as `host:port`.
    pub fn address(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let cfg = ServerConfig::default();
        assert_eq!(cfg.port, 8080);
        assert_eq!(cfg.host, "0.0.0.0");
        assert_eq!(cfg.version, "1.0.0");
        assert!(!cfg.enable_grpc);
        assert!(!cfg.enable_cors);
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
