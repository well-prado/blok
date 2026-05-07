package com.blok.blok.config;

import com.blok.blok.logging.LogLevel;

import java.util.Objects;

/**
 * Configuration for the blok runtime server(s).
 * Can be created from environment variables via {@link #fromEnv()}.
 * <p>
 * Environment variables:
 * <ul>
 *   <li>PORT - HTTP port (default: 9003 — matches the runner's DEFAULT_PORTS.java)</li>
 *   <li>HOST - Bind address (default: 0.0.0.0)</li>
 *   <li>VERSION - Runtime version (default: 1.0.0)</li>
 *   <li>GRPC_PORT - gRPC port (default: 10003 — matches DEFAULT_GRPC_PORTS.java = HTTP+1000)</li>
 *   <li>BLOK_TRANSPORT - "http" | "grpc" | "both" (default: "http")</li>
 *   <li>LOG_LEVEL - Minimum log level: DEBUG, INFO, WARN, ERROR (default: INFO)</li>
 *   <li>ENABLE_CORS - Enable CORS: true/false (default: false)</li>
 *   <li>SHUTDOWN_TIMEOUT - Graceful shutdown timeout in seconds (default: 10)</li>
 * </ul>
 */
public class ServerConfig {

    /** Selects which server(s) to start. */
    public enum Transport {
        /** HTTP only (default; preserves existing behavior). */
        HTTP,
        /** gRPC only on {@link ServerConfig#getGrpcPort()}. */
        GRPC,
        /** HTTP and gRPC concurrently — used during migration. */
        BOTH;

        public static Transport fromString(String value) {
            if (value == null) return HTTP;
            return switch (value.toLowerCase()) {
                case "grpc" -> GRPC;
                case "both" -> BOTH;
                default -> HTTP;
            };
        }
    }

    private int port;
    private String host;
    private String version;
    private int grpcPort;
    private Transport transport;
    private LogLevel logLevel;
    private boolean enableCors;
    private int shutdownTimeoutSec;

    /**
     * Creates a ServerConfig with default values.
     */
    public ServerConfig() {
        this.port = 9003;
        this.host = "0.0.0.0";
        this.version = "1.0.0";
        this.grpcPort = 10003;
        this.transport = Transport.HTTP;
        this.logLevel = LogLevel.INFO;
        this.enableCors = false;
        this.shutdownTimeoutSec = 10;
    }

    /**
     * Creates a ServerConfig from environment variables, falling back to defaults.
     *
     * @return a configured ServerConfig
     */
    public static ServerConfig fromEnv() {
        ServerConfig config = new ServerConfig();

        String portStr = System.getenv("PORT");
        if (portStr != null && !portStr.isBlank()) {
            try {
                int port = Integer.parseInt(portStr.trim());
                if (port > 0) {
                    config.port = port;
                }
            } catch (NumberFormatException ignored) {
            }
        }

        String host = System.getenv("HOST");
        if (host != null && !host.isBlank()) {
            config.host = host.trim();
        }

        String version = System.getenv("VERSION");
        if (version != null && !version.isBlank()) {
            config.version = version.trim();
        }

        String grpcPortStr = System.getenv("GRPC_PORT");
        if (grpcPortStr != null && !grpcPortStr.isBlank()) {
            try {
                int gport = Integer.parseInt(grpcPortStr.trim());
                if (gport > 0) {
                    config.grpcPort = gport;
                }
            } catch (NumberFormatException ignored) {
            }
        }

        String transport = System.getenv("BLOK_TRANSPORT");
        if (transport != null && !transport.isBlank()) {
            config.transport = Transport.fromString(transport.trim());
        }

        String logLevel = System.getenv("LOG_LEVEL");
        if (logLevel != null && !logLevel.isBlank()) {
            config.logLevel = LogLevel.fromString(logLevel, LogLevel.INFO);
        }

        String enableCors = System.getenv("ENABLE_CORS");
        if ("true".equalsIgnoreCase(enableCors) || "1".equals(enableCors)) {
            config.enableCors = true;
        }

        String shutdownTimeout = System.getenv("SHUTDOWN_TIMEOUT");
        if (shutdownTimeout != null && !shutdownTimeout.isBlank()) {
            try {
                int timeout = Integer.parseInt(shutdownTimeout.trim());
                if (timeout > 0) {
                    config.shutdownTimeoutSec = timeout;
                }
            } catch (NumberFormatException ignored) {
            }
        }

        return config;
    }

    /**
     * Returns the host:port address string.
     *
     * @return the address
     */
    public String address() {
        return host + ":" + port;
    }

    // Getters and setters

    public int getPort() {
        return port;
    }

    public void setPort(int port) {
        this.port = port;
    }

    public String getHost() {
        return host;
    }

    public void setHost(String host) {
        this.host = host != null ? host : "0.0.0.0";
    }

    public String getVersion() {
        return version;
    }

    public void setVersion(String version) {
        this.version = version != null ? version : "1.0.0";
    }

    public int getGrpcPort() {
        return grpcPort;
    }

    public void setGrpcPort(int grpcPort) {
        this.grpcPort = grpcPort;
    }

    public Transport getTransport() {
        return transport;
    }

    public void setTransport(Transport transport) {
        this.transport = transport != null ? transport : Transport.HTTP;
    }

    public LogLevel getLogLevel() {
        return logLevel;
    }

    public void setLogLevel(LogLevel logLevel) {
        this.logLevel = logLevel != null ? logLevel : LogLevel.INFO;
    }

    public boolean isEnableCors() {
        return enableCors;
    }

    public void setEnableCors(boolean enableCors) {
        this.enableCors = enableCors;
    }

    public int getShutdownTimeoutSec() {
        return shutdownTimeoutSec;
    }

    public void setShutdownTimeoutSec(int shutdownTimeoutSec) {
        this.shutdownTimeoutSec = shutdownTimeoutSec;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        ServerConfig that = (ServerConfig) o;
        return port == that.port &&
                grpcPort == that.grpcPort &&
                transport == that.transport &&
                enableCors == that.enableCors &&
                shutdownTimeoutSec == that.shutdownTimeoutSec &&
                Objects.equals(host, that.host) &&
                Objects.equals(version, that.version) &&
                logLevel == that.logLevel;
    }

    @Override
    public int hashCode() {
        return Objects.hash(port, host, version, grpcPort, transport, logLevel, enableCors, shutdownTimeoutSec);
    }

    @Override
    public String toString() {
        return "ServerConfig{" +
                "port=" + port +
                ", host='" + host + '\'' +
                ", version='" + version + '\'' +
                ", grpcPort=" + grpcPort +
                ", transport=" + transport +
                ", logLevel=" + logLevel +
                ", enableCors=" + enableCors +
                ", shutdownTimeoutSec=" + shutdownTimeoutSec +
                '}';
    }
}
