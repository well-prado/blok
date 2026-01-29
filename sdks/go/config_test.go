package nanoservice

import (
	"os"
	"testing"
)

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultConfig()

	if cfg.Port != 8080 {
		t.Errorf("expected port 8080, got %d", cfg.Port)
	}
	if cfg.Host != "0.0.0.0" {
		t.Errorf("expected host '0.0.0.0', got %q", cfg.Host)
	}
	if cfg.Version != "1.0.0" {
		t.Errorf("expected version '1.0.0', got %q", cfg.Version)
	}
	if cfg.ReadTimeoutSec != 30 {
		t.Errorf("expected read timeout 30, got %d", cfg.ReadTimeoutSec)
	}
	if cfg.LogLevel != LogLevelInfo {
		t.Errorf("expected INFO log level, got %v", cfg.LogLevel)
	}
	if cfg.EnableCORS {
		t.Error("expected CORS disabled by default")
	}
}

func TestLoadConfigFromEnv(t *testing.T) {
	// Set env vars
	os.Setenv("PORT", "9090")
	os.Setenv("HOST", "127.0.0.1")
	os.Setenv("VERSION", "2.0.0")
	os.Setenv("LOG_LEVEL", "DEBUG")
	os.Setenv("ENABLE_CORS", "true")
	os.Setenv("READ_TIMEOUT", "60")
	defer func() {
		os.Unsetenv("PORT")
		os.Unsetenv("HOST")
		os.Unsetenv("VERSION")
		os.Unsetenv("LOG_LEVEL")
		os.Unsetenv("ENABLE_CORS")
		os.Unsetenv("READ_TIMEOUT")
	}()

	cfg := LoadConfigFromEnv()

	if cfg.Port != 9090 {
		t.Errorf("expected port 9090, got %d", cfg.Port)
	}
	if cfg.Host != "127.0.0.1" {
		t.Errorf("expected host '127.0.0.1', got %q", cfg.Host)
	}
	if cfg.Version != "2.0.0" {
		t.Errorf("expected version '2.0.0', got %q", cfg.Version)
	}
	if cfg.LogLevel != LogLevelDebug {
		t.Errorf("expected DEBUG, got %v", cfg.LogLevel)
	}
	if !cfg.EnableCORS {
		t.Error("expected CORS enabled")
	}
	if cfg.ReadTimeoutSec != 60 {
		t.Errorf("expected read timeout 60, got %d", cfg.ReadTimeoutSec)
	}
}

func TestLoadConfigFromEnvInvalidValues(t *testing.T) {
	os.Setenv("PORT", "not-a-number")
	os.Setenv("READ_TIMEOUT", "-5")
	defer func() {
		os.Unsetenv("PORT")
		os.Unsetenv("READ_TIMEOUT")
	}()

	cfg := LoadConfigFromEnv()

	// Should fall back to defaults
	if cfg.Port != 8080 {
		t.Errorf("expected default port 8080, got %d", cfg.Port)
	}
	// Negative timeout should be ignored
	if cfg.ReadTimeoutSec != 30 {
		t.Errorf("expected default read timeout 30, got %d", cfg.ReadTimeoutSec)
	}
}

func TestServerConfigAddress(t *testing.T) {
	cfg := ServerConfig{Host: "0.0.0.0", Port: 8080}
	if cfg.Address() != "0.0.0.0:8080" {
		t.Errorf("expected '0.0.0.0:8080', got %q", cfg.Address())
	}
}
