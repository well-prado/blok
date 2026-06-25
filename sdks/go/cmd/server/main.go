// Package main provides the entry point for the blok Go runtime server.
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

	blok "github.com/nickincloud/blok-go"
	"github.com/nickincloud/blok-go/examples/nodes"
)

func main() {
	// Create registry and register nodes
	registry := blok.NewNodeRegistry()

	// Register all example nodes
	nodes.RegisterAll(registry)

	// Register user nodes scaffolded under runtimes/go/nodes. This is a no-op
	// in the SDK tree; blokctl regenerates register_user_nodes.go per project.
	registerUserNodes(registry)

	// Add middleware
	logger := blok.NewLogger(blok.LogLevelInfo)
	registry.Use(
		blok.RecoveryMiddleware(),
		blok.LoggingMiddleware(logger),
	)

	// Start serving (reads config from env, handles graceful shutdown)
	if err := blok.ListenAndServe(registry); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}
