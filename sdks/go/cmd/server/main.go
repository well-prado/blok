// Package main provides the entry point for the nanoservice Go runtime server.
//
// Usage:
//
//	go run ./cmd/server
//
// Environment variables:
//
//	PORT          - HTTP port (default: 8080)
//	HOST          - Bind address (default: 0.0.0.0)
//	VERSION       - Runtime version (default: 1.0.0)
//	LOG_LEVEL     - Log level: DEBUG, INFO, WARN, ERROR (default: INFO)
//	ENABLE_CORS   - Enable CORS: true/false (default: false)
package main

import (
	"log"

	nanoservice "github.com/nickincloud/nanoservice-go"
	"github.com/nickincloud/nanoservice-go/examples/nodes"
)

func main() {
	// Create registry and register nodes
	registry := nanoservice.NewNodeRegistry()

	// Register all example nodes
	nodes.RegisterAll(registry)

	// Add middleware
	logger := nanoservice.NewLogger(nanoservice.LogLevelInfo)
	registry.Use(
		nanoservice.RecoveryMiddleware(),
		nanoservice.LoggingMiddleware(logger),
	)

	// Start serving (reads config from env, handles graceful shutdown)
	if err := nanoservice.ListenAndServe(registry); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}
