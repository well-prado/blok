package blok

import (
	"os"
	"strconv"
)

// Transport identifies which server(s) to start.
type Transport string

const (
	// TransportHTTP runs the HTTP server only (default; existing behavior).
	TransportHTTP Transport = "http"
	// TransportGRPC runs the gRPC server only.
	TransportGRPC Transport = "grpc"
	// TransportBoth runs HTTP and gRPC in the same process during migration.
	TransportBoth Transport = "both"
)

// ServerConfig holds the configuration for the blok runtime server(s).
type ServerConfig struct {
	// Port is the HTTP port to listen on (default: 9001 — matches the
	// runner's DEFAULT_PORTS.go).
	Port int

	// Host is the bind address (default: "0.0.0.0").
	Host string

	// Version is the runtime version reported in health checks.
	Version string

	// GRPCPort is the gRPC port to listen on (default: 10001 — matches the
	// runner's DEFAULT_GRPC_PORTS.go = HTTP+1000).
	GRPCPort int

	// Transport selects which server(s) to start. Default: TransportHTTP.
	// Override via the BLOK_TRANSPORT env var.
	Transport Transport

	// ReadTimeoutSec is the HTTP read timeout in seconds (default: 30).
	ReadTimeoutSec int

	// WriteTimeoutSec is the HTTP write timeout in seconds (default: 30).
	WriteTimeoutSec int

	// ShutdownTimeoutSec is the graceful shutdown timeout in seconds (default: 10).
	ShutdownTimeoutSec int

	// LogLevel is the minimum log level (default: INFO).
	LogLevel LogLevel

	// EnableCORS enables CORS headers on all responses (default: false).
	EnableCORS bool
}

// DefaultConfig returns a ServerConfig with sensible defaults.
func DefaultConfig() ServerConfig {
	return ServerConfig{
		Port:               9001,
		Host:               "0.0.0.0",
		Version:            "1.0.0",
		GRPCPort:           10001,
		Transport:          TransportHTTP,
		ReadTimeoutSec:     30,
		WriteTimeoutSec:    30,
		ShutdownTimeoutSec: 10,
		LogLevel:           LogLevelInfo,
		EnableCORS:         false,
	}
}

// LoadConfigFromEnv loads configuration from environment variables,
// falling back to defaults for unset variables.
//
// Environment variables:
//   - PORT: HTTP port (default: 9001 — matches DEFAULT_PORTS.go on the runner)
//   - HOST: Bind address (default: 0.0.0.0)
//   - VERSION: Runtime version (default: 1.0.0)
//   - GRPC_PORT: gRPC port (default: 10001 — matches DEFAULT_GRPC_PORTS.go)
//   - BLOK_TRANSPORT: "http" | "grpc" | "both" (default: "http")
//   - READ_TIMEOUT: Read timeout in seconds (default: 30)
//   - WRITE_TIMEOUT: Write timeout in seconds (default: 30)
//   - SHUTDOWN_TIMEOUT: Shutdown timeout in seconds (default: 10)
//   - LOG_LEVEL: Minimum log level: DEBUG, INFO, WARN, ERROR (default: INFO)
//   - ENABLE_CORS: Enable CORS: true/false (default: false)
func LoadConfigFromEnv() ServerConfig {
	cfg := DefaultConfig()

	if v := os.Getenv("PORT"); v != "" {
		if port, err := strconv.Atoi(v); err == nil && port > 0 {
			cfg.Port = port
		}
	}

	if v := os.Getenv("HOST"); v != "" {
		cfg.Host = v
	}

	if v := os.Getenv("VERSION"); v != "" {
		cfg.Version = v
	}

	if v := os.Getenv("GRPC_PORT"); v != "" {
		if port, err := strconv.Atoi(v); err == nil && port > 0 {
			cfg.GRPCPort = port
		}
	}

	if v := os.Getenv("BLOK_TRANSPORT"); v != "" {
		switch Transport(v) {
		case TransportHTTP, TransportGRPC, TransportBoth:
			cfg.Transport = Transport(v)
		}
	}

	if v := os.Getenv("READ_TIMEOUT"); v != "" {
		if t, err := strconv.Atoi(v); err == nil && t > 0 {
			cfg.ReadTimeoutSec = t
		}
	}

	if v := os.Getenv("WRITE_TIMEOUT"); v != "" {
		if t, err := strconv.Atoi(v); err == nil && t > 0 {
			cfg.WriteTimeoutSec = t
		}
	}

	if v := os.Getenv("SHUTDOWN_TIMEOUT"); v != "" {
		if t, err := strconv.Atoi(v); err == nil && t > 0 {
			cfg.ShutdownTimeoutSec = t
		}
	}

	if v := os.Getenv("LOG_LEVEL"); v != "" {
		switch v {
		case "DEBUG":
			cfg.LogLevel = LogLevelDebug
		case "INFO":
			cfg.LogLevel = LogLevelInfo
		case "WARN":
			cfg.LogLevel = LogLevelWarn
		case "ERROR":
			cfg.LogLevel = LogLevelError
		}
	}

	if v := os.Getenv("ENABLE_CORS"); v == "true" || v == "1" {
		cfg.EnableCORS = true
	}

	return cfg
}

// Address returns the host:port address string.
func (c ServerConfig) Address() string {
	return c.Host + ":" + strconv.Itoa(c.Port)
}
